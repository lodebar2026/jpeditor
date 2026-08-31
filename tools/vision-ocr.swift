// Apple Vision 文字识别：从原 PDF 裁一块，直接送系统 OCR。
//
//   swiftc -O -o tools/vision-ocr tools/vision-ocr.swift -framework Vision -framework PDFKit
//   tools/vision-ocr <pdf> <page> <x> <y> <w> <h> [scale] [langs]     # 单块
//   echo '{"pdf":"…","scale":6,"items":[{"page":54,"x":52,"y":494,"w":309,"h":41}]}' \
//     | tools/vision-ocr --batch                                      # 批量（走 stdin）
//
// 坐标是 **PDF 点、y 从页顶量**（与 pdf-layout.json 同一口径），输出也换算回同一口径。
//
// 为什么要它：注解里的英文与标点，PP-OCR（中文模型）读不准——「Charlotte」读成
// 「Char10tte」、逗号整行整行地漏、开引号读不出。Vision 对拉丁文字与标点强得多，
// 而且不用起浏览器。**批量走 stdin**：一行一个进程的话，进程启动就占掉四分之三的时间
//（单块 0.25s，批量摊到 0.02s）。
import Foundation
import Vision
import PDFKit
import CoreGraphics

struct Item: Decodable { let page: Int; let x: Double; let y: Double; let w: Double; let h: Double }
struct Job: Decodable { let pdf: String; let items: [Item]; let scale: Double?; let langs: [String]? }

func recognize(page: PDFPage, x: Double, y: Double, w: Double, h: Double, scale: Double, langs: [String]) -> [[String: Any]] {
  let bounds = page.bounds(for: .mediaBox)
  let crop = CGRect(x: x, y: bounds.height - y - h, width: w, height: h)
  let pxW = max(1, Int((w * scale).rounded())), pxH = max(1, Int((h * scale).rounded()))
  guard let ctx = CGContext(data: nil, width: pxW, height: pxH, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return [] }
  ctx.setFillColor(gray: 1, alpha: 1)
  ctx.fill(CGRect(x: 0, y: 0, width: pxW, height: pxH))
  ctx.scaleBy(x: scale, y: scale)
  ctx.translateBy(x: -crop.minX, y: -crop.minY)
  page.draw(with: .mediaBox, to: ctx)
  guard let img = ctx.makeImage() else { return [] }

  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.recognitionLanguages = langs
  req.usesLanguageCorrection = false // 注解里是人名、经文出处，纠错只会帮倒忙
  let handler = VNImageRequestHandler(cgImage: img, options: [:])
  guard (try? handler.perform([req])) != nil else { return [] }

  var out: [[String: Any]] = []
  for ob in (req.results ?? []) {
    guard let top = ob.topCandidates(1).first else { continue }
    // Vision 的 bbox 是归一化、y 从底量；换回 PDF 点、y 从页顶量
    let bb = ob.boundingBox
    out.append([
      "text": top.string,
      "confidence": Double(top.confidence),
      "x": x + Double(bb.minX) * w,
      "y": y + (1 - Double(bb.maxY)) * h,
      "w": Double(bb.width) * w,
      "h": Double(bb.height) * h,
    ])
  }
  return out
}

let a = CommandLine.arguments
if a.count >= 2, a[1] == "--batch" {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  guard let job = try? JSONDecoder().decode(Job.self, from: data),
        let doc = PDFDocument(url: URL(fileURLWithPath: job.pdf)) else { exit(64) }
  let scale = job.scale ?? 6
  let langs = job.langs ?? ["zh-Hans", "en-US"]
  var pages: [Int: PDFPage] = [:]
  var results: [[[String: Any]]] = []
  for it in job.items {
    let pg = pages[it.page] ?? doc.page(at: it.page - 1)
    if let pg { pages[it.page] = pg; results.append(recognize(page: pg, x: it.x, y: it.y, w: it.w, h: it.h, scale: scale, langs: langs)) }
    else { results.append([]) }
  }
  FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: ["results": results], options: []))
  exit(0)
}

guard a.count >= 7,
      let doc = PDFDocument(url: URL(fileURLWithPath: a[1])),
      let pageNo = Int(a[2]), let page = doc.page(at: pageNo - 1),
      let x = Double(a[3]), let y = Double(a[4]), let w = Double(a[5]), let h = Double(a[6])
else {
  FileHandle.standardError.write("用法: vision-ocr <pdf> <page> <x> <y> <w> <h> [scale] [langs] | --batch\n".data(using: .utf8)!)
  exit(64)
}
let lines = recognize(page: page, x: x, y: y, w: w, h: h,
                      scale: a.count > 7 ? (Double(a[7]) ?? 6) : 6,
                      langs: a.count > 8 ? a[8].split(separator: ",").map(String.init) : ["zh-Hans", "en-US"])
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: ["lines": lines], options: []))
