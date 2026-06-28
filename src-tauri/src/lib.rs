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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![export_pdf_cmd, omr_gemini_cmd])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
