// 必须写在 binary crate 根（main.rs），写在 lib.rs 对安装包 exe 无效。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // GUI 子系统进程启动时 PATH 可能不含 System32，导致子进程（Shell/Claude）找不到依赖。
    // 必须在任何子进程启动前修复环境变量。
    aiterm_lib::process_util::fix_gui_environment();
    if aiterm_lib::mcp_stdio_proxy::try_run_mcp_stdio_proxy() {
        return;
    }
    aiterm_lib::run();
}
