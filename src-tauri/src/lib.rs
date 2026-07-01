use svg2pdf::{usvg, ConversionOptions, PageOptions};
use lopdf::{Document, Object, ObjectId};
use tauri::Manager;

/// Build usvg options with system fonts + bundled Bravura.otf embedded.
fn build_usvg_options(app_handle: &tauri::AppHandle) -> usvg::Options {
    let mut options = usvg::Options::default();
    options.fontdb_mut().load_system_fonts();
    // Load bundled Bravura.otf from Tauri resources
    if let Ok(res_dir) = app_handle.path().resource_dir() {
        let bravura = res_dir.join("Bravura.otf");
        if bravura.exists() {
            options.fontdb_mut().load_font_file(&bravura).ok();
        }
    }
    options
}

/// Convert a single SVG string to a single-page PDF (bytes).
fn svg_to_pdf_bytes(svg_str: &str, options: &usvg::Options) -> Result<Vec<u8>, String> {
    let tree = usvg::Tree::from_str(svg_str, options)
        .map_err(|e| format!("usvg: {e}"))?;
    svg2pdf::to_pdf(&tree, ConversionOptions::default(), PageOptions::default())
        .map_err(|e| format!("svg2pdf: {e}"))
}

/// Merge single-page PDFs into a multi-page PDF using lopdf.
fn merge_pdf_pages(pdfs: Vec<Vec<u8>>) -> Result<Vec<u8>, String> {
    if pdfs.is_empty() {
        return Err("no pages".into());
    }
    if pdfs.len() == 1 {
        return Ok(pdfs.into_iter().next().unwrap());
    }

    // Load all source documents
    let mut docs: Vec<Document> = pdfs
        .iter()
        .map(|b| Document::load_mem(b).map_err(|e| e.to_string()))
        .collect::<Result<_, _>>()?;

    // Renumber objects in each doc to avoid ID conflicts
    let mut next_id: u32 = 1;
    for doc in &mut docs {
        doc.renumber_objects_with(next_id);
        next_id += doc.max_id + 2;
    }

    // IDs for the merged document's Pages dict and Catalog
    let pages_id: ObjectId = (next_id, 0);
    next_id += 1;
    let catalog_id: ObjectId = (next_id, 0);
    next_id += 1;

    let mut merged = Document::with_version("1.5");
    let mut page_ids: Vec<ObjectId> = Vec::new();

    for doc in &docs {
        // Get the single page's ObjectId
        let page_oid: ObjectId = doc
            .get_pages()
            .get(&1)
            .copied()
            .ok_or("no page in source doc")?;
        page_ids.push(page_oid);

        // Find the old catalog/pages IDs to skip when copying
        let old_catalog_id: Option<ObjectId> = doc
            .trailer
            .get(b"Root")
            .ok()
            .and_then(|r| r.as_reference().ok());

        let old_pages_id: Option<ObjectId> = old_catalog_id
            .and_then(|cid| doc.get_object(cid).ok())
            .and_then(|obj| obj.as_dict().ok())
            .and_then(|d| d.get(b"Pages").ok())
            .and_then(|r| r.as_reference().ok());

        // Copy all objects except old catalog and pages tree
        for (&oid, obj) in &doc.objects {
            let skip = Some(oid) == old_catalog_id || Some(oid) == old_pages_id;
            if !skip {
                merged.objects.insert(oid, obj.clone());
            }
        }
    }

    // Update each page's /Parent to point to our new pages dict
    for &page_oid in &page_ids {
        if let Some(Object::Dictionary(dict)) = merged.objects.get_mut(&page_oid) {
            dict.set("Parent", Object::Reference(pages_id));
        }
    }

    // Build /Pages dictionary
    let kids: Vec<Object> = page_ids.iter().map(|&id| Object::Reference(id)).collect();
    let mut pages_dict = lopdf::Dictionary::new();
    pages_dict.set("Type", Object::Name(b"Pages".to_vec()));
    pages_dict.set("Kids", Object::Array(kids));
    pages_dict.set("Count", Object::Integer(page_ids.len() as i64));
    merged.objects.insert(pages_id, Object::Dictionary(pages_dict));

    // Build /Catalog
    let mut cat_dict = lopdf::Dictionary::new();
    cat_dict.set("Type", Object::Name(b"Catalog".to_vec()));
    cat_dict.set("Pages", Object::Reference(pages_id));
    merged.objects.insert(catalog_id, Object::Dictionary(cat_dict));

    merged.trailer.set("Root", Object::Reference(catalog_id));
    merged.max_id = next_id;

    let mut buf: Vec<u8> = Vec::new();
    merged.save_to(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

#[tauri::command]
fn export_pdf_cmd(
    pages_svg: Vec<String>,
    width_pt: f32,
    height_pt: f32,
    out_path: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let _ = (width_pt, height_pt); // embedded in SVG viewBox
    let options = build_usvg_options(&app_handle);

    let page_pdfs: Result<Vec<Vec<u8>>, String> = pages_svg
        .iter()
        .map(|svg| svg_to_pdf_bytes(svg, &options))
        .collect();
    let page_pdfs = page_pdfs?;

    let merged = merge_pdf_pages(page_pdfs)?;
    std::fs::write(&out_path, &merged).map_err(|e| e.to_string())
}

// ---------------- OMR：经 Antigravity CLI (`agy`) 驱动 Gemini ----------------

/// 运行 agy print 模式，返回 stdout。print 模式必须关闭 stdin，否则会一直等待输入而挂起。
fn run_agy(args: &[&str]) -> Result<String, String> {
    use std::process::{Command, Stdio};
    let output = Command::new("agy")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("启动 agy 失败：{e}（请确认已安装 Antigravity CLI / agy 在 PATH 中）"))?;
    if !output.status.success() && output.stdout.is_empty() {
        return Err(format!(
            "agy 退出码 {:?}\n{}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// 从 agy 输出里抽取 MusicXML 文档（去 markdown 围栏，截取 <score-partwise>..</score-partwise>）。
fn extract_musicxml(stdout: &str) -> Option<String> {
    let s = stdout.replace("```xml", "").replace("```", "");
    let i = s.find("<score-partwise")?;
    let j = s.rfind("</score-partwise>")?;
    let body = &s[i..j + "</score-partwise>".len()];
    let xml = if body.starts_with("<?xml") {
        body.to_string()
    } else {
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n{body}")
    };
    Some(xml)
}

/// 整页简谱图 → MusicXML（Gemini 方案）。
#[tauri::command]
fn omr_gemini_cmd(image_path: String, model: Option<String>) -> Result<String, String> {
    let model = model.unwrap_or_else(|| "Gemini 3.1 Pro (High)".into());
    let dir = std::path::Path::new(&image_path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let prompt = format!(
        "你是简谱(jianpu / numbered musical notation) OCR 引擎。请查看图片文件：{image_path}\n\
         这是一页简谱(数字 1-7 表示音级，可能有八度点、下划线、增时线、附点、小节线、歌词)。\n\
         把其中的乐谱转写成 MusicXML 3.0 partwise(score-partwise)，规则：\n\
         - 数字 1-7 = 调内音级(可动 do)，按标题里的调号(如 1=C)映射成 <pitch>；\n\
         - 数字上/下的点 = 高/低八度；下划线每条使时值减半(无线=四分,一条=八分,两条=十六分)；\n\
         - 增时线 - 表示延长一拍；附点 . 表示附点；小节线 | 分小节；休止符 0；\n\
         - 只做主旋律单声部即可。\n\
         只输出 MusicXML 文档本身(以 <?xml 开头到 </score-partwise> 结束)，不要任何解释、不要代码围栏。"
    );
    let out = run_agy(&[
        "-p", &prompt, "--add-dir", &dir, "--new-project",
        "--dangerously-skip-permissions", "--model", &model, "--print-timeout", "8m",
    ])?;
    extract_musicxml(&out).ok_or_else(|| format!("未能从 agy 输出解析出 MusicXML：\n{}", out.chars().take(500).collect::<String>()))
}

// ── 简谱 OMR 原生 OCR 推理（onnxruntime via ort）─────────────────────────────
// 前端 paddleocr.ts 在 Tauri 下把预处理好的输入张量经二进制 IPC 交来，这里用原生 onnxruntime
// 跑 session.run 再把 logits 传回（CTC 解码/几何仍在前端）。比浏览器 wasm 多线程快 ~3×。
//
// 二进制协议（避开 JSON 序列化大数组的开销）——
//   请求体: [model u8(0=rec,1=det)][ndims u8][dims i32×ndims (LE)][f32 data (LE)]
//   响应体: [ndims u8][dims i32×ndims (LE)][f32 data (LE)]
use std::sync::Mutex;

static REC_SESS: Mutex<Option<ort::session::Session>> = Mutex::new(None);
static DET_SESS: Mutex<Option<ort::session::Session>> = Mutex::new(None);

fn ocr_model_path(app: &tauri::AppHandle, file: &str) -> Result<std::path::PathBuf, String> {
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("ocr").join(file))
}

fn ensure_ocr_session(
    slot: &mut Option<ort::session::Session>,
    app: &tauri::AppHandle,
    file: &str,
) -> Result<(), String> {
    if slot.is_none() {
        let path = ocr_model_path(app, file)?;
        let sess = ort::session::Session::builder()
            .map_err(|e| e.to_string())?
            .with_intra_threads(4)
            .map_err(|e| e.to_string())?
            .commit_from_file(&path)
            .map_err(|e| format!("加载模型 {} 失败: {}", path.display(), e))?;
        *slot = Some(sess);
    }
    Ok(())
}

#[inline]
fn ri32(b: &[u8], o: usize) -> i32 {
    i32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

/// 跑一次推理。model 0=rec,1=det；mode 0=完整 f32 输出，1=每时间步 argmax 索引 [N,T]（仅 rec，
/// 把 [N,T,6625] logits 的 ~6625× 传输量砍成索引）。返回 (输出维度, 输出数据字节：mode1=int32 索引，mode0=f32)。
fn infer_one(
    app: &tauri::AppHandle,
    model: i32,
    mode: i32,
    dims: Vec<i64>,
    data: Vec<f32>,
) -> Result<(Vec<i32>, Vec<u8>), String> {
    let (slot_mutex, file) = if model == 0 {
        (&REC_SESS, "rec.onnx")
    } else {
        (&DET_SESS, "det.onnx")
    };
    let mut guard = slot_mutex.lock().map_err(|e| e.to_string())?;
    ensure_ocr_session(&mut guard, app, file)?;
    let sess = guard.as_mut().unwrap();
    let iname = sess.inputs()[0].name().to_string();
    let oname = sess.outputs()[0].name().to_string();
    let tensor = ort::value::Tensor::from_array((dims, data)).map_err(|e| e.to_string())?;
    let outputs = sess
        .run(ort::inputs![iname.as_str() => tensor])
        .map_err(|e| e.to_string())?;
    let (shape, out) = outputs[oname.as_str()]
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;

    if mode == 1 {
        let (bn, t, c) = (shape[0] as usize, shape[1] as usize, shape[2] as usize);
        let mut idx: Vec<i32> = Vec::with_capacity(bn * t);
        for i in 0..bn * t {
            let base = i * c;
            let mut best = 0usize;
            let mut bv = f32::NEG_INFINITY;
            for k in 0..c {
                let v = out[base + k];
                if v > bv {
                    bv = v;
                    best = k;
                }
            }
            idx.push(best as i32);
        }
        Ok((vec![bn as i32, t as i32], bytemuck::cast_slice(&idx).to_vec()))
    } else {
        let out_dims: Vec<i32> = shape.iter().map(|&d| d as i32).collect();
        Ok((out_dims, bytemuck::cast_slice(out).to_vec()))
    }
}

/// 从字节流按偏移解析一个子请求 int32[model,mode,ndims,dims...] + f32[data]，返回解析结果与推进后的偏移。
fn parse_req(body: &[u8], mut off: usize) -> Result<(i32, i32, Vec<i64>, Vec<f32>, usize), String> {
    if body.len() < off + 12 {
        return Err("omr_onnx 子请求头越界".into());
    }
    let model = ri32(body, off);
    let mode = ri32(body, off + 4);
    let ndims = ri32(body, off + 8) as usize;
    off += 12;
    if body.len() < off + ndims * 4 {
        return Err("omr_onnx 维度越界".into());
    }
    let mut dims: Vec<i64> = Vec::with_capacity(ndims);
    for i in 0..ndims {
        dims.push(ri32(body, off + i * 4) as i64);
    }
    off += ndims * 4;
    let n: usize = dims.iter().map(|&d| d as usize).product();
    if body.len() < off + n * 4 {
        return Err("omr_onnx 数据越界".into());
    }
    let mut data: Vec<f32> = vec![0.0; n];
    for (i, v) in data.iter_mut().enumerate() {
        let b = off + i * 4;
        *v = f32::from_le_bytes([body[b], body[b + 1], body[b + 2], body[b + 3]]);
    }
    off += n * 4;
    Ok((model, mode, dims, data, off))
}

fn write_result(resp: &mut Vec<u8>, out_dims: &[i32], out_bytes: &[u8]) {
    resp.extend_from_slice(&(out_dims.len() as i32).to_le_bytes());
    for &d in out_dims {
        resp.extend_from_slice(&d.to_le_bytes());
    }
    resp.extend_from_slice(out_bytes);
}

/// 单张量推理。请求 int32[model,mode,ndims,dims...]+f32[data]；响应 int32[ndims,dims...]+data。
#[tauri::command]
fn omr_onnx(
    app: tauri::AppHandle,
    request: tauri::ipc::Request,
) -> Result<tauri::ipc::Response, String> {
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(v) => v.as_slice(),
        _ => return Err("omr_onnx 需要原始字节请求体".into()),
    };
    let (model, mode, dims, data, _) = parse_req(body, 0)?;
    let (out_dims, out_bytes) = infer_one(&app, model, mode, dims, data)?;
    let mut resp: Vec<u8> = Vec::with_capacity((1 + out_dims.len()) * 4 + out_bytes.len());
    write_result(&mut resp, &out_dims, &out_bytes);
    Ok(tauri::ipc::Response::new(resp))
}

/// 多张量批量推理（一次 IPC 携带 N 个子请求，内部逐个 session.run）——把 Tauri 每次 ~数 ms 的往返开销
/// 从 N 次压到 1 次，同时保持逐个推理的算力最优。请求 int32[count] + count×子请求；
/// 响应 int32[count] + count×(int32[ndims,dims...]+data)。
#[tauri::command]
fn omr_onnx_batch(
    app: tauri::AppHandle,
    request: tauri::ipc::Request,
) -> Result<tauri::ipc::Response, String> {
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(v) => v.as_slice(),
        _ => return Err("omr_onnx_batch 需要原始字节请求体".into()),
    };
    if body.len() < 4 {
        return Err("omr_onnx_batch 请求体过短".into());
    }
    let count = ri32(body, 0) as usize;
    let mut off = 4usize;
    let mut resp: Vec<u8> = Vec::new();
    resp.extend_from_slice(&(count as i32).to_le_bytes());
    for _ in 0..count {
        let (model, mode, dims, data, next) = parse_req(body, off)?;
        off = next;
        let (out_dims, out_bytes) = infer_one(&app, model, mode, dims, data)?;
        write_result(&mut resp, &out_dims, &out_bytes);
    }
    Ok(tauri::ipc::Response::new(resp))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![export_pdf_cmd, omr_gemini_cmd, omr_onnx, omr_onnx_batch])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
