use wasm_bindgen::prelude::*;
use scraper::{Html, Selector};

#[wasm_bindgen]
pub fn convert_html_to_markdown(html: &str) -> Result<String, JsError> {
    let cleaned = clean_html(html);
    htmd::HtmlToMarkdown::builder()
        .skip_tags(vec![
            "script", "style", "noscript", "svg", "iframe", "object", "embed",
        ])
        .build()
        .convert(&cleaned)
        .map_err(|error| JsError::new(&error.to_string()))
}

fn clean_html(html: &str) -> String {
    let mut document = Html::parse_document(html);
    let root_id = document
        .tree
        .root()
        .children()
        .find(|child| child.value().is_element())
        .map(|node| node.id());
    for selector in [
        "nav", "header", "footer", "[class*='cookie']", "[class*='sidebar']", "[class*='ad-']",
        "[class*='advert']", "[id*='cookie']", "[id*='sidebar']", "[id*='ad-']", "[id*='advert']",
    ]
    .iter()
    .filter_map(|value| Selector::parse(value).ok())
    {
        let ids = document.select(&selector).map(|element| element.id()).collect::<Vec<_>>();
        for id in ids {
            if Some(id) == root_id {
                continue;
            }
            if let Some(mut node) = document.tree.get_mut(id) {
                node.detach();
            }
        }
    }
    document.html()
}
