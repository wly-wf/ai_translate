//! Deterministic guard for Chinese prose accidentally left in an English result.
//! Literal exceptions must occur verbatim in the source, including delimiters.
use super::is_cjk_character;

pub(super) const REPAIR_INSTRUCTION: &str = "The previous draft still contains untranslated Chinese in English prose. Translate every remaining ordinary word, idiom, quotation, and descriptive phrase into natural English; use romanization for names without an established English form. Only verbatim code, URLs, and placeholders already present in the source may retain Chinese characters. Do not hide untranslated words by adding code delimiters. Recheck the entire draft against the original source for completeness and meaning. Return only the complete corrected translation, without commentary.";

pub(super) fn has_untranslated_chinese(source: &str, translation: &str, target: &str) -> bool {
    if target != "English" {
        return false;
    }
    let mut offset = 0;
    while offset < translation.len() {
        let rest = &translation[offset..];
        if let Some(length) = literal_length(rest) {
            if source.contains(&rest[..length]) {
                offset += length;
                continue;
            }
        }
        let character = rest.chars().next().unwrap();
        if is_cjk_character(character) {
            return true;
        }
        offset += character.len_utf8();
    }
    false
}

fn literal_length(text: &str) -> Option<usize> {
    if text.starts_with('`') {
        let count = text.bytes().take_while(|byte| *byte == b'`').count();
        let delimiter = &text[..count];
        return text[count..].find(delimiter).map(|end| count + end + count);
    }
    for (start, end) in [("{{", "}}"), ("${", "}"), ("{", "}")] {
        if let Some(rest) = text.strip_prefix(start) {
            let end_offset = rest.find(end)?;
            let value = &rest[..end_offset];
            // Restrict placeholders to identifier-like content, not arbitrary prose.
            if !value.is_empty() && value.chars().all(|c| c.is_alphanumeric() || "_.-".contains(c)) {
                return Some(start.len() + end_offset + end.len());
            }
            return None;
        }
    }
    if text.starts_with("https://") || text.starts_with("http://") {
        return Some(text.find(|c: char| c.is_whitespace() || "<>\"'`()[]{}，。；！？".contains(c)).unwrap_or(text.len()));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_screenshot_and_other_untranslated_prose() {
        for draft in ["I don't want to 折腾 your history.", "This is 麻烦.", "He said ‘你好’.", "Hello 𠀀"] {
            assert!(has_untranslated_chinese("我不想折腾你的历史。", draft, "English"));
        }
    }

    #[test]
    fn allows_only_verbatim_source_literals() {
        for literal in ["`中文变量`", "```js\nconst 名字 = '你好';\n```", "https://example.com/中文", "{{姓名}}", "${用户名}", "{用户名}"] {
            let source = format!("保留 {literal}，翻译其余内容。");
            let result = format!("Preserve {literal} and translate the rest.");
            assert!(!has_untranslated_chinese(&source, &result, "English"), "{literal}");
        }
        assert!(has_untranslated_chinese("不要折腾。", "Do not `折腾`.", "English"));
        assert!(has_untranslated_chinese("保留 `变量`。", "Keep `变量`，不要折腾.", "English"));
        assert!(has_untranslated_chinese("`变量`", "`其他变量`", "English"));
        assert!(has_untranslated_chinese("{这是一句 普通话}", "{这是一句 普通话}", "English"));
        assert!(has_untranslated_chinese("请看 https://example.com。折腾", "See https://example.com。折腾", "English"));
    }

    #[test]
    fn accepts_english_and_does_not_reject_chinese_target() {
        assert!(!has_untranslated_chinese("不想折腾你的历史", "I don't want to rewrite your history.", "English"));
        assert!(!has_untranslated_chinese("Hello", "你好", "Simplified Chinese"));
        assert!(has_untranslated_chinese("变量", "An unclosed `变量", "English"));
    }

    fn mock_translation(source: &str, replies: &[&str]) -> (Result<crate::ProviderTranslation, String>, Vec<serde_json::Value>) {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::time::{Duration, Instant};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let replies: Vec<String> = replies.iter().map(|text| serde_json::json!({
            "choices": [{"finish_reason": "stop", "message": {"content": text}}]
        }).to_string()).collect();
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for reply in replies {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline, "expected translation request was not sent");
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("mock accept failed: {error}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                loop {
                    let count = socket.read(&mut buffer).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length: usize = headers.lines().find_map(|line| line.strip_prefix("content-length:")).unwrap().trim().parse().unwrap();
                        if bytes.len() >= end + 4 + length {
                            requests.push(serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap());
                            break;
                        }
                    }
                }
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).unwrap();
            }
            requests
        });
        let config = crate::StoredProviderConfig {
            vendor_name: "Local mock".into(), api_key: String::new(), base_url,
            model: "mock".into(), models: vec!["mock".into()],
        };
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let result = runtime.block_on(crate::request_translation_with_config(
            "openai".into(), "mock".into(), source.into(), crate::UserPreferences::default(), config,
        ));
        (result, server.join().unwrap())
    }

    #[test]
    fn request_repairs_residual_chinese_once_using_the_original_source() {
        let source = "我不想折腾你的历史。";
        let draft = "I didn't want to折腾 your history.";
        let corrected = "I didn't want to rewrite your history.";
        let (result, requests) = mock_translation(source, &[draft, corrected]);
        assert_eq!(result.unwrap().translation.as_deref(), Some(corrected));
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["messages"][1], requests[1]["messages"][1]);
        assert!(requests[1]["messages"][1]["content"].as_str().unwrap().contains(source));
        assert_eq!(requests[1]["messages"][2]["content"], draft);
        assert_eq!(requests[1]["messages"][3]["content"], REPAIR_INSTRUCTION);
    }

    #[test]
    fn request_rejects_a_second_bad_draft_instead_of_publishing_it() {
        let (result, requests) = mock_translation("不要折腾。", &["Do not 折腾.", "Do not `折腾`."]);
        assert!(result.unwrap_err().contains("自动纠正一次"));
        assert_eq!(requests.len(), 2);
    }

    #[test]
    fn request_does_not_retry_valid_literals_or_chinese_translation() {
        for (source, output) in [("保留 `中文变量`。", "Keep `中文变量`."), ("Hello", "你好")] {
            let (result, requests) = mock_translation(source, &[output]);
            assert_eq!(result.unwrap().translation.as_deref(), Some(output));
            assert_eq!(requests.len(), 1);
        }
    }
}
