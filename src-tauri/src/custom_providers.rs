//! Persistent custom-provider identities, including the legacy `openai` slot.
use crate::{account_entry, provider_keyring_entry, KeyringError};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const ACCOUNT: &str = "custom-provider-ids";
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

pub(crate) fn is_custom_provider(id: &str) -> bool {
    id == "openai" || id.strip_prefix("custom-").is_some_and(|suffix|
        suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

pub(crate) fn custom_provider_ids() -> Result<Vec<String>, String> {
    let mut ids: Vec<String> = match account_entry(ACCOUNT)?.get_password() {
        Ok(value) => serde_json::from_str(&value).map_err(|e| format!("无法读取自定义供应商列表：{e}"))?,
        Err(KeyringError::NoEntry) => Vec::new(),
        Err(error) => return Err(format!("无法读取自定义供应商列表：{error}")),
    };
    // Existing users keep their original credential and identity, including
    // when that provider was disabled and absent from the enabled list.
    match provider_keyring_entry("openai")?.get_password() {
        Ok(_) => { if !ids.iter().any(|id| id == "openai") { ids.push("openai".into()); } }
        Err(KeyringError::NoEntry) => {}
        Err(error) => return Err(format!("无法读取旧版自定义供应商：{error}")),
    }
    let mut unique = Vec::new();
    for id in ids {
        if is_custom_provider(&id) && !unique.contains(&id) { unique.push(id); }
    }
    Ok(unique)
}

pub(crate) fn save_custom_provider_ids(ids: &[String]) -> Result<(), String> {
    let value = serde_json::to_string(ids).map_err(|e| e.to_string())?;
    account_entry(ACCOUNT)?.set_password(&value).map_err(|e| format!("无法保存自定义供应商列表：{e}"))
}

pub(crate) fn new_custom_provider_id() -> Result<String, String> {
    loop {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
        let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let id = format!("custom-{:032x}", stamp + u128::from(sequence));
        match provider_keyring_entry(&id)?.get_password() {
            Err(KeyringError::NoEntry) => return Ok(id),
            Ok(_) => continue,
            Err(error) => return Err(format!("无法创建供应商标识：{error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_legacy_and_independent_ids_only() {
        assert!(is_custom_provider("openai"));
        assert!(is_custom_provider("custom-0123456789abcdef0123456789abcdef"));
        for id in ["deepseek", "custom-", "custom-../secret", "custom-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"] {
            assert!(!is_custom_provider(id));
        }
    }

    #[test]
    fn custom_instances_keep_their_identity_in_order_and_authentication() {
        let first = "custom-00000000000000000000000000000001";
        let second = "custom-00000000000000000000000000000002";
        assert!(crate::supported_provider(first));
        let ordered = crate::apply_provider_order(vec![first.into(), second.into(), "openai".into()],
            &[second.into(), first.into()]);
        assert_eq!(ordered, vec![second, first, "openai"]);
        let endpoint = "https://demo.openai.azure.com/openai/deployments/test/chat/completions";
        let request = crate::authenticated_request(reqwest::Client::new().get(endpoint), first, "instance-key", endpoint)
            .build().unwrap();
        assert_eq!(request.headers().get("api-key").unwrap(), "instance-key");
        assert!(request.headers().get("authorization").is_none());
    }
}
