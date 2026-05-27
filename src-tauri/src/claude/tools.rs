use crate::runtime::{self, RuntimeStore};
use crate::secrets::{self, redact_for_display, substitute_command_placeholders};
use crate::shell_tool::ShellToolCoordinator;
use crate::state::IdeContext;
use crate::terminal::{self, tail_snippet, TerminalManager};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub struct ToolContext<'a> {
    pub app: &'a AppHandle,
    pub ide_context: &'a Arc<Mutex<IdeContext>>,
    pub runtime: &'a Arc<RuntimeStore>,
    pub terminals: &'a TerminalManager,
    pub shell_tools: &'a Arc<ShellToolCoordinator>,
}

pub fn get_available_tools() -> Vec<Value> {
    vec![
        tool_def(
            "listServerProfiles",
            "列出侧边栏中已配置的所有服务器/会话（不含密码）",
            json!({}),
        ),
        tool_def(
            "listActiveConnections",
            "列出当前已打开的连接标签、Shell 及终端连接状态",
            json!({}),
        ),
        tool_def(
            "getFocusedServer",
            "获取当前窗口正在查看的连接与 Shell（远程 SSH 会话）",
            json!({}),
        ),
        tool_def(
            "getTerminalContext",
            "获取当前焦点 Shell 标签的最近终端输出摘要",
            json!({}),
        ),
        tool_def(
            "connectServer",
            "在 UI 中打开并连接指定服务器；SSH 登录密码由用户在应用内输入，AI 不参与",
            object_schema(json!({
                "profileId": { "type": "string", "description": "服务器 profile ID（见 listServerProfiles）" }
            }), &["profileId"]),
        ),
        tool_def(
            "disconnectServer",
            "断开指定 profile 的所有终端",
            object_schema(json!({
                "profileId": { "type": "string", "description": "服务器 profile ID" }
            }), &["profileId"]),
        ),
        tool_def_always_load(
            "runShellCommand",
            "在 UI 左侧 Shell 执行命令（与手动输入相同 PTY）。sudo 等交互密码：用户在左侧终端自行输入，AI 不得索要或嵌入密码。",
            object_schema(json!({
                "profileId": { "type": "string", "description": "服务器 profile ID" },
                "command": { "type": "string", "description": "Shell 命令" },
                "shellId": { "type": "string", "description": "可选 Shell 标签 ID" },
                "waitMs": { "type": "number", "description": "等待输出毫秒，默认 8000" }
            }), &["profileId", "command"]),
        ),
        tool_def(
            "listRemoteFiles",
            "列出 SSH 远程目录",
            object_schema(json!({
                "profileId": { "type": "string" },
                "path": { "type": "string", "description": "默认 ~" }
            }), &["profileId"]),
        ),
        tool_def(
            "readRemoteFile",
            "读取 SSH 远程文件",
            object_schema(json!({
                "profileId": { "type": "string" },
                "path": { "type": "string" }
            }), &["profileId", "path"]),
        ),
        tool_def("getWorkspaceFolders", "获取 IDE 工作区目录（本地项目路径）", json!({})),
        tool_def("getOpenFiles", "获取编辑器中打开的文件", json!({})),
        tool_def("getCurrentSelection", "获取当前选中的文本", json!({})),
    ]
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required
    })
}

fn tool_def(name: &str, description: &str, input_schema: Value) -> Value {
    tool_def_with_meta(name, description, input_schema, None)
}

fn tool_def_always_load(name: &str, description: &str, input_schema: Value) -> Value {
    tool_def_with_meta(
        name,
        description,
        input_schema,
        Some(json!({ "anthropic/alwaysLoad": true })),
    )
}

fn tool_def_with_meta(
    name: &str,
    description: &str,
    input_schema: Value,
    meta: Option<Value>,
) -> Value {
    let schema = if input_schema.get("type").and_then(|v| v.as_str()) == Some("object") {
        input_schema
    } else if input_schema.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        json!({ "type": "object", "properties": {} })
    } else {
        input_schema
    };
    let mut tool = json!({
        "name": name,
        "description": description,
        "inputSchema": schema
    });
    if let Some(m) = meta {
        tool["meta"] = m;
    }
    tool
}

pub fn execute_tool(ctx: &ToolContext<'_>, name: &str, args: &Value) -> String {
    let result = match name {
        "listServerProfiles"
        | "list_server_profiles"
        | "listSessions"
        | "mcp__aiterm__listServerProfiles" => tool_list_profiles(ctx),
        "listActiveConnections"
        | "list_active_connections"
        | "mcp__aiterm__listActiveConnections" => tool_list_connections(ctx),
        "getFocusedServer" | "get_focused_server" | "mcp__aiterm__getFocusedServer" => {
            tool_get_focused(ctx)
        }
        "getTerminalContext" | "get_terminal_context" | "mcp__aiterm__getTerminalContext" => {
            tool_terminal_context(ctx)
        }
        "connectServer" | "connect_server" | "connectSession" | "mcp__aiterm__connectServer" => {
            tool_connect(ctx, args)
        }
        "disconnectServer"
        | "disconnect_server"
        | "disconnectSession"
        | "mcp__aiterm__disconnectServer" => tool_disconnect(ctx, args),
        "runShellCommand"
        | "run_shell_command"
        | "executeCommand"
        | "mcp__aiterm__runShellCommand" => tool_run_command(ctx, args),
        "listRemoteFiles" | "list_remote_files" | "mcp__aiterm__listRemoteFiles" => {
            tool_list_files(ctx, args)
        }
        "readRemoteFile" | "read_remote_file" | "mcp__aiterm__readRemoteFile" => {
            tool_read_file(ctx, args)
        }
        "getWorkspaceFolders" | "get_workspace_folders" | "mcp__aiterm__getWorkspaceFolders" => {
            tool_workspace(ctx)
        }
        "getOpenFiles" | "get_open_files" | "mcp__aiterm__getOpenFiles" => tool_open_files(ctx),
        "getCurrentSelection" | "mcp__aiterm__getCurrentSelection" => tool_selection(ctx),
        _ => json!({ "success": false, "error": format!("未知工具: {name}") }),
    };
    serde_json::to_string(&result).unwrap_or_else(|_| "{}".into())
}

fn emit_activity(app: &AppHandle, payload: Value) {
    let _ = app.emit("claude:tool-activity", payload);
}

fn tool_list_profiles(ctx: &ToolContext<'_>) -> Value {
    let snap = ctx.runtime.get();
    json!({
        "success": true,
        "profiles": snap.profiles,
        "hint": "SSH 登录密码在应用 UI 输入；sudo 等命令密码在左侧 Shell 终端手动输入"
    })
}

fn focused_payload(snap: &runtime::RuntimeSnapshot) -> Value {
    let conn = RuntimeStore::focused_connection_static(snap);
    let profile = conn.and_then(|c| snap.profiles.iter().find(|p| p.id == c.profile_id));
    let shell = conn.and_then(|c| RuntimeStore::focused_shell_static(snap, c));
    let terminal_session_id = shell.map(|s| s.terminal_session_id.as_str());
    let snippet = terminal_session_id
        .map(|id| tail_snippet(id, 12_000))
        .unwrap_or_default();
    let is_remote = profile
        .map(|p| p.session_type == "ssh" || p.session_type == "telnet")
        .unwrap_or(false);

    json!({
        "activeConnectionId": snap.active_connection_id,
        "activeShellId": snap.active_shell_id,
        "connection": conn,
        "profile": profile,
        "shell": shell,
        "terminalSessionId": terminal_session_id,
        "isRemoteSession": is_remote,
        "sessionHost": ctx_lock_session_host(profile, conn),
        "terminalSnippetChars": snippet.len(),
        "terminalSnippet": if snippet.is_empty() { Value::Null } else { json!(snippet) },
        "hint": if snap.connections.is_empty() {
            "当前没有已打开的连接标签；请让用户在 AI Terminal 中点击「连接」，或调用 connect_server"
        } else if conn.is_none() {
            "有连接但未选中焦点标签；以 activeConnectionId 为准"
        } else if is_remote {
            "焦点为远程 SSH/Telnet 会话，勿与下方 IDE 工作区目录混淆"
        } else {
            "焦点为本机/WSL 终端"
        },
    })
}

fn ctx_lock_session_host(
    profile: Option<&runtime::ProfileSnapshot>,
    conn: Option<&runtime::ConnectionSnapshot>,
) -> Option<String> {
    match profile {
        Some(p) if p.session_type == "ssh" || p.session_type == "telnet" => {
            let user = p.user.as_deref().unwrap_or("root");
            let port = p.port.map(|n| format!(":{n}")).unwrap_or_default();
            Some(format!("{user}@{}{port}", p.host))
        }
        Some(p) => Some(format!("{} ({})", p.host, p.session_type)),
        None => conn.map(|c| c.host.clone()),
    }
}

fn tool_list_connections(ctx: &ToolContext<'_>) -> Value {
    let snap = ctx.runtime.get();
    let mut connections: Vec<Value> = Vec::new();
    for c in &snap.connections {
        let profile = snap.profiles.iter().find(|p| p.id == c.profile_id);
        connections.push(json!({
            "id": c.id,
            "profileId": c.profile_id,
            "profileName": c.profile_name,
            "host": c.host,
            "sessionType": profile.map(|p| &p.session_type),
            "isRemote": profile.map(|p| p.session_type == "ssh" || p.session_type == "telnet").unwrap_or(false),
            "activeShellId": c.active_shell_id,
            "shells": c.shells,
        }));
    }
    json!({
        "success": true,
        "connections": connections,
        "activeConnectionId": snap.active_connection_id,
        "activeShellId": snap.active_shell_id,
        "focused": focused_payload(&snap),
    })
}

fn tool_get_focused(ctx: &ToolContext<'_>) -> Value {
    let snap = ctx.runtime.get();
    let mut payload = focused_payload(&snap);
    if let Value::Object(ref mut map) = payload {
        map.insert("success".into(), json!(true));
    }
    payload
}

fn tool_terminal_context(ctx: &ToolContext<'_>) -> Value {
    let snap = ctx.runtime.get();
    let focused = focused_payload(&snap);
    let ctx_lock = ctx.ide_context.lock();
    json!({
        "success": true,
        "sessionName": ctx_lock.active_session_name,
        "sessionHost": focused.get("sessionHost").cloned().unwrap_or_else(|| json!(ctx_lock.active_session_host)),
        "terminalSnippet": focused.get("terminalSnippet").cloned().unwrap_or_else(|| json!(ctx_lock.terminal_snippet)),
        "activeProfileId": ctx_lock.active_profile_id,
        "activeConnectionId": ctx_lock.active_connection_id,
        "activeShellId": ctx_lock.active_shell_id,
        "isRemoteSession": focused.get("isRemoteSession"),
        "terminalSessionId": focused.get("terminalSessionId"),
        "focused": focused,
    })
}

fn tool_workspace(ctx: &ToolContext<'_>) -> Value {
    let ctx_lock = ctx.ide_context.lock();
    let snap = ctx.runtime.get();
    let focused = focused_payload(&snap);
    json!({
        "success": true,
        "folders": ctx_lock.workspace_folders,
        "rootPath": ctx_lock.workspace_folders.first(),
        "note": "此为 Claude IDE 工作区目录（通常为 AITerm 项目路径），不是 SSH 远程服务器。远程会话请用 getFocusedServer / listActiveConnections",
        "focusedServer": focused,
    })
}

fn tool_open_files(ctx: &ToolContext<'_>) -> Value {
    let ctx_lock = ctx.ide_context.lock();
    json!({
        "success": true,
        "files": ctx_lock.open_files,
        "activeFilePath": ctx_lock.active_file_path,
    })
}

fn tool_selection(ctx: &ToolContext<'_>) -> Value {
    let ctx_lock = ctx.ide_context.lock();
    json!({
        "success": ctx_lock.selected_text.is_some(),
        "text": ctx_lock.selected_text,
        "filePath": ctx_lock.active_file_path,
    })
}

fn tool_connect(ctx: &ToolContext<'_>, args: &Value) -> Value {
    let profile_id = args
        .get("profileId")
        .or_else(|| args.get("sessionId"))
        .and_then(|v| v.as_str());
    let Some(pid) = profile_id else {
        return json!({ "success": false, "error": "缺少 profileId" });
    };
    let _ = ctx.app.emit(
        "claude:tool-request",
        json!({
            "tool": "connectServer",
            "profileId": pid,
            "requestId": uuid::Uuid::new_v4().to_string(),
        }),
    );
    emit_activity(
        ctx.app,
        json!({
            "kind": "connect",
            "profileId": pid,
            "displayCommand": format!("连接服务器 {pid}"),
        }),
    );
    json!({
        "success": true,
        "message": format!("已请求连接服务器 {pid}，请在界面查看连接进度"),
        "profileId": pid,
    })
}

fn tool_disconnect(ctx: &ToolContext<'_>, args: &Value) -> Value {
    let profile_id = args
        .get("profileId")
        .or_else(|| args.get("sessionId"))
        .and_then(|v| v.as_str());
    let Some(pid) = profile_id else {
        return json!({ "success": false, "error": "缺少 profileId" });
    };
    let snap = ctx.runtime.get();
    let mut disconnected = Vec::new();
    for conn in &snap.connections {
        if conn.profile_id != pid {
            continue;
        }
        for shell in &conn.shells {
            if ctx.terminals.is_connected(&shell.terminal_session_id) {
                let _ = ctx
                    .terminals
                    .disconnect(ctx.app, &shell.terminal_session_id);
                disconnected.push(shell.terminal_session_id.clone());
            }
        }
    }
    let _ = ctx.app.emit(
        "claude:tool-request",
        json!({ "tool": "disconnectServer", "profileId": pid }),
    );
    emit_activity(
        ctx.app,
        json!({
            "kind": "disconnect",
            "profileId": pid,
            "terminalSessions": disconnected,
        }),
    );
    json!({
        "success": true,
        "profileId": pid,
        "disconnected": disconnected,
    })
}

fn tool_run_command(ctx: &ToolContext<'_>, args: &Value) -> Value {
    let profile_id = args
        .get("profileId")
        .or_else(|| args.get("sessionId"))
        .and_then(|v| v.as_str());
    let command = args.get("command").and_then(|v| v.as_str());
    let shell_id = args.get("shellId").and_then(|v| v.as_str());
    let wait_ms = args.get("waitMs").and_then(|v| v.as_u64()).unwrap_or(8000);

    let (Some(pid), Some(cmd)) = (profile_id, command) else {
        tracing::warn!("runShellCommand: missing profileId or command");
        return json!({ "success": false, "error": "缺少 profileId 或 command" });
    };

    tracing::info!("runShellCommand: profile={}, command={}", pid, cmd);

    let Some((terminal_session_id, resolved_profile, _shell)) =
        ctx.runtime.find_terminal_session(pid, shell_id)
    else {
        tracing::warn!("runShellCommand: terminal session not found for profile={}", pid);
        return json!({
            "success": false,
            "error": format!("未找到已连接终端 profile={pid}，请先 connectServer")
        });
    };

    tracing::info!("runShellCommand: terminal_session_id={}", terminal_session_id);

    let session_type = ctx
        .runtime
        .get()
        .profiles
        .iter()
        .find(|p| p.id == resolved_profile)
        .map(|p| p.session_type.clone())
        .unwrap_or_else(|| "local".to_string());

    if !ctx.terminals.is_connected(&terminal_session_id) {
        tracing::warn!("runShellCommand: terminal not connected: {}", terminal_session_id);
        return json!({
            "success": false,
            "error": "终端未连接",
            "terminalSessionId": terminal_session_id,
        });
    }

    let display_cmd = redact_for_display(cmd, Some(&resolved_profile));
    let real_cmd = substitute_command_placeholders(cmd, Some(&resolved_profile));
    let real_cmd = crate::terminal::prepare_command_for_pty(&real_cmd, &session_type);

    tracing::info!("runShellCommand: executing command, display={}", display_cmd);

    emit_activity(
        ctx.app,
        json!({
            "kind": "shell_command",
            "status": "running",
            "profileId": resolved_profile,
            "terminalSessionId": terminal_session_id,
            "command": display_cmd,
        }),
    );

    // 通知前端切换并聚焦对应 Shell 标签（执行由 Rust PTY 完成，不依赖前端回传）
    let _ = ctx.app.emit(
        "claude:tool-request",
        json!({
            "tool": "runShellCommand",
            "requestId": uuid::Uuid::new_v4().to_string(),
            "profileId": resolved_profile,
            "terminalSessionId": terminal_session_id,
            "command": display_cmd,
            "displayCommand": display_cmd,
            "focusOnly": true,
        }),
    );

    match ctx.terminals.run_command_with_display(
        &ctx.app,
        &terminal_session_id,
        &real_cmd,
        wait_ms,
    ) {
        Ok(output) => {
            let preview: String = output.chars().take(4000).collect();
            tracing::info!("runShellCommand: completed, output_len={}", output.len());
            emit_activity(
                ctx.app,
                json!({
                    "kind": "shell_command",
                    "status": "completed",
                    "profileId": resolved_profile,
                    "terminalSessionId": terminal_session_id,
                    "command": display_cmd,
                    "outputPreview": preview,
                }),
            );
            json!({
                "success": true,
                "profileId": resolved_profile,
                "terminalSessionId": terminal_session_id,
                "command": display_cmd,
                "output": preview,
            })
        }
        Err(e) => {
            tracing::error!("runShellCommand: failed with error: {}", e);
            emit_activity(
                ctx.app,
                json!({
                    "kind": "shell_command",
                    "status": "error",
                    "profileId": resolved_profile,
                    "command": display_cmd,
                    "error": e,
                }),
            );
            json!({ "success": false, "error": e, "command": display_cmd })
        }
    }
}

fn build_connect_request(profile: &crate::runtime::ProfileSnapshot, terminal_session_id: &str) -> terminal::ConnectRequest {
    let (auth_method, password, private_key_path) = secrets::to_connect_auth(&profile.id);
    terminal::ConnectRequest {
        sessionId: terminal_session_id.to_string(),
        session_type: profile.session_type.clone(),
        host: profile.host.clone(),
        port: profile.port,
        user: profile.user.clone(),
        authMethod: auth_method,
        password,
        privateKeyPath: private_key_path,
    }
}

fn tool_list_files(ctx: &ToolContext<'_>, args: &Value) -> Value {
    let profile_id = args
        .get("profileId")
        .or_else(|| args.get("sessionId"))
        .and_then(|v| v.as_str());
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("~");
    let Some(pid) = profile_id else {
        return json!({ "success": false, "error": "缺少 profileId" });
    };
    let Some(profile) = ctx.runtime.profile_by_id(pid) else {
        return json!({ "success": false, "error": "未知 profileId" });
    };
    if profile.session_type != "ssh" {
        return json!({ "success": false, "error": "仅 SSH 支持远程文件列表" });
    }
    let request = build_connect_request(&profile, &format!("{pid}::fs"));
    match tauri::async_runtime::block_on(terminal::list_remote_directory(
        request,
        path.to_string(),
        false,
    )) {
        Ok(entries) => json!({ "success": true, "path": path, "entries": entries }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}

fn tool_read_file(ctx: &ToolContext<'_>, args: &Value) -> Value {
    let profile_id = args
        .get("profileId")
        .or_else(|| args.get("sessionId"))
        .and_then(|v| v.as_str());
    let path = args.get("path").and_then(|v| v.as_str());
    let (Some(pid), Some(p)) = (profile_id, path) else {
        return json!({ "success": false, "error": "缺少 profileId 或 path" });
    };
    let Some(profile) = ctx.runtime.profile_by_id(pid) else {
        return json!({ "success": false, "error": "未知 profileId" });
    };
    let request = build_connect_request(&profile, &format!("{pid}::fs"));
    match tauri::async_runtime::block_on(terminal::read_remote_file(request, p.to_string(), false))
    {
        Ok(content) => {
            let preview: String = content.chars().take(8000).collect();
            json!({ "success": true, "path": p, "content": preview })
        }
        Err(e) => json!({ "success": false, "error": e }),
    }
}
