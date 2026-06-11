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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![export_pdf_cmd])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
