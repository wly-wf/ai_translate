// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if translator_lib::windows_selection::run_capture_helper_if_requested() {
        return;
    }
    translator_lib::run()
}
