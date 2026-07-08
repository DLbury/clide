use crate::connect_tool::ConnectToolCoordinator;
use crate::runtime::{self, RuntimeStore};
use crate::secrets::{self, redact_for_display, substitute_command_placeholders};
use crate::shell_tool::ShellToolCoordinator;
use crate::state::IdeContext;
use crate::terminal::{self, tail_snippet, TerminalManager, TunnelManager};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub struct ToolContext<'a> {
    pub app: &'a AppHandle,
    pub ide_context: &'a Arc<Mutex<IdeContext>>,
    pub runtime: &'a Arc<RuntimeStore>,
    pub terminals: &'a TerminalManager,
    pub tunnels: &'a TunnelManager,
    pub shell_tools: &'a Arc<ShellToolCoordinator>,
    pub connect_tools: &'a Arc<ConnectToolCoordinator>,
}

pub fn get_available_tools() -> Vec<Value> {
    vec![
        tool_def(
            "listServerProfiles",
            "列出侧边栏已保存的服务器配置（profileId、名称、主机等，不含密码）。用于发现可用 profileId。",
            json!({}),
        ),
        tool_def(
            "listActiveConnections",
            "列出当前已打开的连接标签、各 Shell 的 shellId/连接状态。多服务器场景下查 profileId 与终端是否已连。",
            json!({}),
        ),
        tool_def(
            "getFocusedServer",
            "返回 UI 当前焦点所在的连接与 Shell（profileId、shellId、terminalSessionId）。焦点不等于唯一可操作目标。",
            json!({}),
        ),
        tool_def(
            "getTerminalContext",
            "读取指定 Shell 的终端输出快照（最近约 12k 字符），不向 PTY 发送新命令。可选 shellId 读取非焦点 Shell。",
            object_schema(json!({
                "profileId": { "type": "string", "description": "服务器 profile ID（与 shellId 配合时）" },
                "shellId": { "type": "string", "description": "Shell 标签 ID；省略则读当前焦点 Shell" }
            }), &[]),
        ),
        tool_def(
            "createNewShell",
            "为连接新增一个 Shell 标签（新 PTY）。splitBelow=true 时在 referenceShellId 对应面板下方垂直拆分；返回后需用 listActiveConnections 获取新 shellId。",
            object_schema(json!({
                "profileId": { "type": "string", "description": "服务器 profile ID" },
                "name": { "type": "string", "description": "Shell 显示名称" },
                "referenceShellId": { "type": "string", "description": "参考 Shell 的 shellId（splitBelow 时使用）" },
                "splitBelow": { "type": "boolean", "description": "是否在参考面板下方拆分，而非仅开新标签" }
            }), &["profileId"]),
        ),
        tool_def(
            "disconnectServer",
            "断开指定 profile 的所有 PTY 连接。",
            object_schema(json!({
                "profileId": { "type": "string", "description": "服务器 profile ID" }
            }), &["profileId"]),
        ),
        tool_def(
            "runShellCommand",
            "在指定 Shell 的 PTY 中执行一条命令（与用户手动输入相同路径），等待提示符或 waitMs 超时后返回 output。同一 shellId 同时只能跑一条前台命令；incomplete 表示可能仍在运行。",
            object_schema(json!({
                "profileId": { "type": "string", "description": "服务器 profile ID" },
                "command": { "type": "string", "description": "Shell 命令" },
                "shellId": { "type": "string", "description": "目标 Shell 标签 ID；省略则用该连接当前活动 Shell" },
                "waitMs": { "type": "number", "description": "等待毫秒，默认 30000；0 表示长时间等待（上限约 10 分钟）" }
            }), &["profileId", "command"]),
        ),
        tool_def(
            "connectServer",
            "连接指定 profile 的 SSH/终端（若尚未连接）。已连接则直接返回；后台连接，不切换用户当前可见的服务器标签。",
            object_schema(json!({
                "profileId": { "type": "string", "description": "服务器 profile ID" }
            }), &["profileId"]),
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
        tool_def(
            "listPortForwards",
            "列出指定服务器 profile 上由本应用建立的 SSH 本地端口转发（隧道）",
            object_schema(json!({
                "profileId": { "type": "string", "description": "服务器 profile ID" }
            }), &["profileId"]),
        ),
        tool_def(
            "openRemoteBrowser",
            "通过 SSH 本地端口转发打开远程 Web 服务，并在工作台新增浏览器标签页。remoteHost 为服务器侧目标地址（如 127.0.0.1 或内网 IP），remotePort 为目标端口。",
            object_schema(json!({
                "profileId": { "type": "string", "description": "已连接的 SSH 服务器 profile ID" },
                "remoteHost": { "type": "string", "description": "远程目标主机，默认 127.0.0.1（服务器本机）" },
                "remotePort": { "type": "number", "description": "远程目标端口，如 8080、3000" },
                "path": { "type": "string", "description": "可选 URL 路径，如 /grafana" },
                "title": { "type": "string", "description": "浏览器标签标题" }
            }), &["profileId", "remotePort"]),
        ),
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
    } else if input_schema
        .as_object()
        .map(|o| o.is_empty())
        .unwrap_or(true)
    {
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

pub async fn execute_tool(ctx: &ToolContext<'_>, name: &str, args: &Value) -> String {
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
            tool_terminal_context(ctx, args)
        }
        "createNewShell" | "create_new_shell" | "mcp__aiterm__createNewShell" => {
            tool_create_new_shell(ctx, args)
        }
        "connectServer" | "connect_server" | "connectSession" | "mcp__aiterm__connectServer" => {
            tool_connect(ctx, args).await
        }
        "disconnectServer"
        | "disconnect_server"
        | "disconnectSession"
        | "mcp__aiterm__disconnectServer" => tool_disconnect(ctx, args),
        "runShellCommand"
        | "run_shell_command"
        | "executeCommand"
        | "mcp__aiterm__runShellCommand" => tool_run_command(ctx, args).await,
        "listRemoteFiles" | "list_remote_files" | "mcp__aiterm__listRemoteFiles" => {
            tool_list_files(ctx, args).await
        }
        "readRemoteFile" | "read_remote_file" | "mcp__aiterm__readRemoteFile" => {
            tool_read_file(ctx, args).await
        }
        "getWorkspaceFolders" | "get_workspace_folders" | "mcp__aiterm__getWorkspaceFolders" => {
            tool_workspace(ctx)
        }
        "getOpenFiles" | "get_open_files" | "mcp__aiterm__getOpenFiles" => tool_open_files(ctx),
        "getCurrentSelection" | "mcp__aiterm__getCurrentSelection" => tool_selection(ctx),
        "listPortForwards" | "list_port_forwards" | "mcp__aiterm__listPortForwards" => {
            tool_list_port_forwards(ctx, args)
        }
        "openRemoteBrowser" | "open_remote_browser" | "mcp__aiterm__openRemoteBrowser" => {
            tool_open_remote_browser(ctx, args).await
        }
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

fn tool_terminal_context(ctx: &ToolContext<'_>, args: &Value) -> Value {
    tracing::info!("tool_terminal_context: start");
    let snap = ctx.runtime.get();
    let shell_id_arg = args.get("shellId").and_then(|v| v.as_str());
    let profile_id_arg = args
        .get("profileId")
        .or_else(|| args.get("sessionId"))
        .and_then(|v| v.as_str());

    let resolved = if let Some(shell_id) = shell_id_arg {
        if let Some(pid) = profile_id_arg {
            ctx.runtime.find_terminal_session(pid, Some(shell_id))
        } else {
            snap.connections.iter().find_map(|conn| {
                conn.shells
                    .iter()
                    .find(|s| s.id == shell_id)
                    .map(|s| (s.terminal_session_id.clone(), conn.profile_id.clone(), s.id.clone()))
            })
        }
    } else {
        None
    };

    let (terminal_session_id, snippet, shell_meta) = if let Some((tid, pid, sid)) = resolved {
        (
            Some(tid.clone()),
            tail_snippet(&tid, 12_000),
            json!({ "profileId": pid, "shellId": sid, "terminalSessionId": tid }),
        )
    } else {
        let focused = focused_payload(&snap);
        let tid = focused
            .get("terminalSessionId")
            .and_then(|v| v.as_str())
            .map(String::from);
        let snippet = tid
            .as_ref()
            .map(|id| tail_snippet(id, 12_000))
            .unwrap_or_default();
        (tid, snippet, focused)
    };

    tracing::info!("tool_terminal_context: got runtime snapshot");
    let ctx_lock = ctx.ide_context.lock();
    tracing::info!("tool_terminal_context: got ide_context lock");
    let result = json!({
        "success": true,
        "sessionName": ctx_lock.active_session_name,
        "sessionHost": ctx_lock.active_session_host,
        "terminalSnippet": if snippet.is_empty() { Value::Null } else { json!(snippet) },
        "activeProfileId": ctx_lock.active_profile_id,
        "activeConnectionId": ctx_lock.active_connection_id,
        "activeShellId": ctx_lock.active_shell_id,
        "terminalSessionId": terminal_session_id,
        "shell": shell_meta,
        "hint": "长任务仍在原 Shell 输出；进度查看请在 splitBelow 新建 Shell 执行，勿在原 Shell runShellCommand",
    });
    tracing::info!(
        "tool_terminal_context: done, result_len={}",
        result.to_string().len()
    );
    result
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

fn tool_list_port_forwards(ctx: &ToolContext<'_>, args: &Value) -> Value {
    let profile_id = args
        .get("profileId")
        .or_else(|| args.get("sessionId"))
        .and_then(|v| v.as_str());
    let Some(pid) = profile_id else {
        return json!({ "success": false, "error": "缺少 profileId" });
    };
    let tunnels = ctx.tunnels.list_for_profile(pid);
    json!({ "success": true, "profileId": pid, "tunnels": tunnels })
}

async fn tool_open_remote_browser(ctx: &ToolContext<'_>, args: &Value) -> Value {
    let profile_id = args
        .get("profileId")
        .or_else(|| args.get("sessionId"))
        .and_then(|v| v.as_str());
    let Some(pid) = profile_id else {
        return json!({ "success": false, "error": "缺少 profileId" });
    };
    let remote_host = args
        .get("remoteHost")
        .and_then(|v| v.as_str())
        .unwrap_or("127.0.0.1");
    let Some(remote_port) = args.get("remotePort").and_then(|v| v.as_u64()) else {
        return json!({ "success": false, "error": "缺少 remotePort" });
    };
    if remote_port == 0 || remote_port > u16::MAX as u64 {
        return json!({ "success": false, "error": "remotePort 无效" });
    }
    let path = args.get("path").and_then(|v| v.as_str());
    let title = args
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| remote_host);

    let snap = ctx.runtime.get();
    if !snap.connections.iter().any(|c| c.profile_id == pid) {
        return json!({
            "success": false,
            "error": format!("服务器 {pid} 未连接，请先调用 connectServer")
        });
    }

    if let Err(err) = crate::browser_policy::validate_browser_host(remote_host) {
        return json!({ "success": false, "error": err });
    }

    match ctx
        .tunnels
        .start(
            ctx.runtime.as_ref(),
            pid,
            remote_host,
            remote_port as u16,
            None,
            path,
        )
        .await
    {
        Ok(info) => {
            let tab_id = uuid::Uuid::new_v4().to_string();
            let _ = ctx.app.emit(
                "claude:tool-request",
                json!({
                    "tool": "openRemoteBrowser",
                    "profileId": pid,
                    "connectionId": snap.connections.iter().find(|c| c.profile_id == pid).map(|c| &c.id),
                    "tunnelId": info.id,
                    "tabId": tab_id,
                    "localUrl": info.local_url,
                    "title": format!("{title}:{remote_port}"),
                }),
            );
            emit_activity(
                ctx.app,
                json!({
                    "kind": "open_browser",
                    "profileId": pid,
                    "remoteHost": remote_host,
                    "remotePort": remote_port,
                    "localUrl": info.local_url,
                }),
            );
            json!({ "success": true, "tunnel": info, "tabId": tab_id })
        }
        Err(e) => json!({ "success": false, "error": e }),
    }
}

fn tool_create_new_shell(ctx: &ToolContext<'_>, args: &Value) -> Value {
    let profile_id = args.get("profileId").and_then(|v| v.as_str());
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("AI Shell");
    let Some(pid) = profile_id else {
        return json!({ "success": false, "error": "缺少 profileId" });
    };

    // 查找连接
    let snap = ctx.runtime.get();
    let conn = snap.connections.iter().find(|c| c.profile_id == pid);
    let Some(conn) = conn else {
        return json!({
            "success": false,
            "error": format!("未找到已连接的会话: {pid}，请先调用 connectServer")
        });
    };

    let shell_num = conn.shells.len() + 1;
    let shell_name = if name == "AI Shell" {
        format!("Shell {}", shell_num)
    } else {
        name.to_string()
    };

    let reference_shell_id = args.get("referenceShellId").and_then(|v| v.as_str());
    let split_below = args.get("splitBelow").and_then(|v| v.as_bool()).unwrap_or(false);

    let request_id = uuid::Uuid::new_v4().to_string();
    let _ = ctx.app.emit(
        "claude:tool-request",
        json!({
            "tool": "createNewShell",
            "profileId": pid,
            "connectionId": conn.id,
            "shellName": shell_name,
            "referenceShellId": reference_shell_id,
            "splitBelow": split_below,
            "requestId": request_id,
        }),
    );
    emit_activity(
        ctx.app,
        json!({
            "kind": "create_shell",
            "profileId": pid,
            "shellName": shell_name,
        }),
    );
    json!({
        "success": true,
        "profileId": pid,
        "shellName": shell_name,
        "referenceShellId": reference_shell_id,
        "splitBelow": split_below,
        "message": if split_below {
            format!("已在 Shell {} 下方拆分新终端: {}", reference_shell_id.unwrap_or("?"), shell_name)
        } else {
            format!("已请求创建新 Shell 标签: {}", shell_name)
        },
    })
}

fn profile_has_connected_terminal(ctx: &ToolContext<'_>, profile_id: &str) -> Option<String> {
    let snap = ctx.runtime.get();
    for conn in &snap.connections {
        if conn.profile_id != profile_id {
            continue;
        }
        for shell in &conn.shells {
            if ctx.terminals.is_connected(&shell.terminal_session_id) {
                return Some(shell.terminal_session_id.clone());
            }
        }
    }
    None
}

async fn tool_connect(ctx: &ToolContext<'_>, args: &Value) -> Value {
    let profile_id = args
        .get("profileId")
        .or_else(|| args.get("sessionId"))
        .and_then(|v| v.as_str());
    let Some(pid) = profile_id else {
        return json!({ "success": false, "error": "缺少 profileId" });
    };

    if let Some(tid) = profile_has_connected_terminal(ctx, pid) {
        return json!({
            "success": true,
            "message": format!("已连接服务器 {pid}"),
            "profileId": pid,
            "terminalSessionId": tid,
        });
    }

    let request_id = uuid::Uuid::new_v4().to_string();
    ctx.connect_tools.begin(request_id.clone());
    let _ = ctx.app.emit(
        "claude:tool-request",
        json!({
            "tool": "connectServer",
            "profileId": pid,
            "requestId": request_id,
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

    let wait_result = ctx.connect_tools.wait(&request_id, 120_000).await;
    ctx.connect_tools.cleanup(&request_id);

    match wait_result {
        Ok(()) => {
            let terminal_session_id = profile_has_connected_terminal(ctx, pid).or_else(|| {
                ctx.runtime
                    .find_terminal_session(pid, None)
                    .map(|(tid, _, _)| tid)
            });
            let mut out = json!({
                "success": true,
                "message": format!("已连接服务器 {pid}"),
                "profileId": pid,
            });
            if let Some(tid) = terminal_session_id {
                out["terminalSessionId"] = json!(tid);
            }
            out
        }
        Err(e) => json!({ "success": false, "error": e, "profileId": pid }),
    }
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

async fn tool_run_command(ctx: &ToolContext<'_>, args: &Value) -> Value {
    let profile_id = args
        .get("profileId")
        .or_else(|| args.get("sessionId"))
        .and_then(|v| v.as_str());
    let command = args.get("command").and_then(|v| v.as_str());
    let shell_id = args.get("shellId").and_then(|v| v.as_str());
    let wait_ms = args.get("waitMs").and_then(|v| v.as_u64()).unwrap_or(30000);

    let (Some(pid), Some(cmd)) = (profile_id, command) else {
        tracing::warn!("runShellCommand: missing profileId or command");
        return json!({ "success": false, "error": "缺少 profileId 或 command" });
    };

    tracing::info!("runShellCommand: profile={}, command={}", pid, cmd);

    let Some((terminal_session_id, resolved_profile, _shell)) =
        ctx.runtime.find_terminal_session(pid, shell_id)
    else {
        tracing::warn!(
            "runShellCommand: terminal session not found for profile={}",
            pid
        );
        return json!({
            "success": false,
            "error": format!("未找到已连接终端 profile={pid}，请先 connectServer")
        });
    };

    tracing::info!(
        "runShellCommand: terminal_session_id={}",
        terminal_session_id
    );

    let session_type = ctx
        .runtime
        .get()
        .profiles
        .iter()
        .find(|p| p.id == resolved_profile)
        .map(|p| p.session_type.clone())
        .unwrap_or_else(|| "local".to_string());

    if !ctx.terminals.is_connected(&terminal_session_id) {
        tracing::warn!(
            "runShellCommand: terminal not connected: {}",
            terminal_session_id
        );
        return json!({
            "success": false,
            "error": "终端未连接",
            "terminalSessionId": terminal_session_id,
        });
    }

    let display_cmd = redact_for_display(cmd, Some(&resolved_profile));
    let real_cmd = substitute_command_placeholders(cmd, Some(&resolved_profile));
    let real_cmd = crate::terminal::prepare_command_for_pty(&real_cmd, &session_type);

    tracing::info!(
        "runShellCommand: executing command, display={}",
        display_cmd
    );

    let request_id = uuid::Uuid::new_v4().to_string();
    ctx.shell_tools.begin(request_id.clone());

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

    // 由前端左侧 Shell 标签写入 PTY 并回传输出（与手动输入同路径，xterm 可见）
    let _ = ctx.app.emit(
        "claude:tool-request",
        json!({
            "tool": "runShellCommand",
            "requestId": request_id,
            "profileId": resolved_profile,
            "terminalSessionId": terminal_session_id,
            "command": real_cmd,
            "displayCommand": display_cmd,
            "waitMs": wait_ms,
            "sessionType": session_type,
        }),
    );

    // 等前端 xterm 标签接管后再等待输出，避免 Rust 阻塞时 UI 尚未写入 PTY
    let started = ctx.shell_tools.wait_until_started(&request_id, 180_000).await;
    if !started {
        ctx.shell_tools.cleanup(&request_id);
        return json!({
            "success": false,
            "error": "前端未能在 3 分钟内接管命令执行（可能正在等待用户确认或终端未连接）"
        });
    }

    // 前端收集输出需要额外时间（切换标签、稳定检测），Rust 侧多等 12s 避免提前超时
    let rust_wait = wait_ms.saturating_add(12_000).min(360_000);
    let result = ctx.shell_tools.wait(&request_id, rust_wait).await;
    ctx.shell_tools.cleanup(&request_id);

    match result {
        Ok(outcome) => {
            let preview: String = outcome.output.chars().take(4000).collect();
            tracing::info!(
                "runShellCommand: completed, output_len={}, timed_out={}",
                outcome.output.len(),
                outcome.timed_out
            );
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
            let mut result = json!({
                "success": true,
                "profileId": resolved_profile,
                "terminalSessionId": terminal_session_id,
                "command": display_cmd,
                "output": preview,
            });
            let output_empty = preview.trim().is_empty() || preview.trim() == "(无输出)";
            if outcome.timed_out || output_empty {
                result["incomplete"] = json!(true);
                result["status"] = json!("running");
                result["message"] = json!(
                    "命令可能仍在运行；output 为等待期间已捕获的内容。getTerminalContext(profileId, shellId) 可读该 Shell 最新输出。需要在其它 PTY 执行新命令时，createNewShell 可另开 Shell（splitBelow 可在参考面板下方拆分）；该 Shell 仍被占用时再次 runShellCommand 可能被拒绝或自动转到监控 Shell。"
                );
            }
            result
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

fn build_connect_request(
    profile: &crate::runtime::ProfileSnapshot,
    terminal_session_id: &str,
) -> terminal::ConnectRequest {
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
        jumpHost: profile.jump_host.clone(),
        jumpHosts: profile.jump_hosts.clone(),
        serial_port: None,
        baud_rate: None,
        data_bits: None,
        stop_bits: None,
        parity: None,
    }
}

async fn tool_list_files(ctx: &ToolContext<'_>, args: &Value) -> Value {
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
    match terminal::list_remote_directory(request, path.to_string(), false).await {
        Ok(entries) => json!({ "success": true, "path": path, "entries": entries }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}

async fn tool_read_file(ctx: &ToolContext<'_>, args: &Value) -> Value {
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
    match terminal::read_remote_file(request, p.to_string(), false).await {
        Ok(content) => {
            let preview: String = content.chars().take(8000).collect();
            json!({ "success": true, "path": p, "content": preview })
        }
        Err(e) => json!({ "success": false, "error": e }),
    }
}
