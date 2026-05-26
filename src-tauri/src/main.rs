// 必须写在 binary crate 根（main.rs），写在 lib.rs 对安装包 exe 无效。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    aiterm_lib::run();
}
