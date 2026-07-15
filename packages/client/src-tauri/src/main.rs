// Coolie client 壳：刻意最小化——PTY/git/引擎全在 coolie-server（spec §2.1、tauri-terminal-poc 结论 b）。
// Rust 只承担 webview 做不到的三件事：读 server.json、detached spawn daemon、PATH 探测 tmux。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
use tauri::Manager;

fn coolie_home() -> PathBuf {
    match std::env::var("COOLIE_HOME") {
        Ok(h) if !h.is_empty() => PathBuf::from(h),
        _ => PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".coolie"),
    }
}

#[tauri::command]
fn read_server_info() -> Option<String> {
    std::fs::read_to_string(coolie_home().join("server.json")).ok()
}

fn spawn_detached(program: &str, args: &[String]) -> Result<(), String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // 新进程组：GUI 退出不连坐 daemon（kobe 所有权分离）
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("spawn {program} failed: {e}"))
}

fn server_argv() -> (String, Vec<String>) {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    (
        repo_root
            .join("node_modules/.bin/tsx")
            .to_string_lossy()
            .into_owned(),
        vec![
            repo_root
                .join("packages/server/src/main.ts")
                .to_string_lossy()
                .into_owned(),
            "start".to_string(),
        ],
    )
}

#[tauri::command]
fn spawn_server() -> Result<(), String> {
    let (program, args) = server_argv();
    spawn_detached(&program, &args)
}

#[derive(Debug, serde::Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum ExternalTerminal {
    Iterm2,
    Terminal,
    Wezterm,
}

#[derive(Debug, PartialEq)]
struct TmuxAttach {
    socket: String,
    session: String,
}

fn parse_tmux_attach(command: &str) -> Result<TmuxAttach, String> {
    let parts = command.split(' ').collect::<Vec<_>>();
    let safe = |value: &str| {
        !value.is_empty()
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    };
    if parts.len() != 6
        || parts[0] != "tmux"
        || parts[1] != "-L"
        || parts[3] != "attach"
        || parts[4] != "-t"
        || !safe(parts[2])
        || !safe(parts[5])
        || !parts[5].starts_with("coolie-")
        || parts[5] == "coolie-"
    {
        return Err(
            "external terminal command must be exactly: tmux -L <socket> attach -t coolie-<workspace>"
                .to_string(),
        );
    }
    Ok(TmuxAttach {
        socket: parts[2].to_string(),
        session: parts[5].to_string(),
    })
}

fn external_terminal_argv(
    terminal: ExternalTerminal,
    attach_command: &str,
) -> Result<(String, Vec<String>), String> {
    let attach = parse_tmux_attach(attach_command)?;
    match terminal {
        ExternalTerminal::Iterm2 => Ok((
            "/usr/bin/osascript".to_string(),
            vec![
                "-e".to_string(),
                format!(
                    "tell application \"iTerm2\"\n  activate\n  set w to (create window with default profile)\n  tell current session of w to write text \"{attach_command}\"\nend tell"
                ),
            ],
        )),
        ExternalTerminal::Terminal => Ok((
            "/usr/bin/osascript".to_string(),
            vec![
                "-e".to_string(),
                format!(
                    "tell application \"Terminal\"\n  activate\n  do script \"{attach_command}\"\nend tell"
                ),
            ],
        )),
        ExternalTerminal::Wezterm => Ok((
            "/Applications/WezTerm.app/Contents/MacOS/wezterm".to_string(),
            vec![
                "start".to_string(),
                "--".to_string(),
                "tmux".to_string(),
                "-L".to_string(),
                attach.socket,
                "attach".to_string(),
                "-t".to_string(),
                attach.session,
            ],
        )),
    }
}

#[tauri::command]
fn open_external_terminal(
    terminal: ExternalTerminal,
    attach_command: String,
) -> Result<(), String> {
    let (program, args) = external_terminal_argv(terminal, &attach_command)?;
    spawn_detached(&program, &args)
}

#[tauri::command]
fn binary_on_path(name: String) -> bool {
    // GUI 进程 PATH 极简（opcode claude_binary.rs 教训）：先查常见安装目录，再扫 PATH
    let candidates = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
    if candidates
        .iter()
        .any(|d| std::path::Path::new(d).join(&name).exists())
    {
        return true;
    }
    std::env::var("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(&name).exists()))
        .unwrap_or(false)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EditorOpenError {
    code: &'static str,
    message: String,
}

impl EditorOpenError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

fn resolve_editor_target(
    workspace_path: &str,
    relative_path: &str,
) -> Result<PathBuf, EditorOpenError> {
    let workspace = Path::new(workspace_path);
    if !workspace.is_absolute() {
        return Err(EditorOpenError::new(
            "invalid_workspace_path",
            "editor workspace path must be absolute",
        ));
    }
    let relative = Path::new(relative_path);
    if relative_path.is_empty()
        || relative.is_absolute()
        || relative.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(EditorOpenError::new(
            "invalid_relative_path",
            "editor path must be relative to the workspace",
        ));
    }

    let root = std::fs::canonicalize(workspace).map_err(|error| {
        EditorOpenError::new(
            "workspace_unavailable",
            format!("cannot resolve editor workspace: {error}"),
        )
    })?;
    if !root.is_dir() {
        return Err(EditorOpenError::new(
            "workspace_unavailable",
            "editor workspace is not a directory",
        ));
    }
    let target = std::fs::canonicalize(root.join(relative)).map_err(|error| {
        EditorOpenError::new(
            "path_unavailable",
            format!("cannot resolve editor path: {error}"),
        )
    })?;
    if !target.starts_with(&root) {
        return Err(EditorOpenError::new(
            "path_outside_workspace",
            "editor path escapes workspace",
        ));
    }
    Ok(target)
}

fn editor_argv(
    configured: Option<&str>,
    target: &Path,
) -> Result<(String, Vec<String>), EditorOpenError> {
    let configured = configured
        .map(|raw| {
            serde_json::from_str::<Vec<String>>(raw).map_err(|error| {
                EditorOpenError::new(
                    "invalid_editor_config",
                    format!("COOLIE_EDITOR_JSON must be a JSON argv array: {error}"),
                )
            })
        })
        .transpose()?;
    let (program, mut args) = match configured {
        Some(argv) if !argv.is_empty() && !argv[0].is_empty() => {
            (argv[0].clone(), argv[1..].to_vec())
        }
        Some(_) => {
            return Err(EditorOpenError::new(
                "invalid_editor_config",
                "COOLIE_EDITOR_JSON must contain a program",
            ))
        }
        None => {
            #[cfg(target_os = "macos")]
            {
                ("open".to_string(), Vec::new())
            }
            #[cfg(not(target_os = "macos"))]
            {
                ("xdg-open".to_string(), Vec::new())
            }
        }
    };
    args.push(target.to_string_lossy().into_owned());
    Ok((program, args))
}

#[tauri::command]
fn open_in_editor(workspace_path: String, relative_path: String) -> Result<(), EditorOpenError> {
    let target = resolve_editor_target(&workspace_path, &relative_path)?;
    let configured = std::env::var("COOLIE_EDITOR_JSON").ok();
    let (program, args) = editor_argv(configured.as_deref(), &target)?;
    Command::new(&program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            EditorOpenError::new(
                "editor_launch_failed",
                format!("cannot launch editor program {program}: {error}"),
            )
        })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_server_info,
            spawn_server,
            open_external_terminal,
            binary_on_path,
            open_in_editor
        ])
        .setup(|app| {
            let win = app.get_webview_window("main").expect("main window");
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                let _ = apply_vibrancy(&win, NSVisualEffectMaterial::Sidebar, None, None);
            }
            // Edit 菜单保留系统角色项：否则 WKWebView 里 Cmd+C/V/X/A 全废（Tauri #2397/#11422 族，spec §7.1）
            let app_menu = Submenu::with_items(
                app,
                "Coolie",
                true,
                &[
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;
            let edit_menu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            app.set_menu(Menu::with_items(app, &[&app_menu, &edit_menu])?)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running coolie client");
}

#[cfg(test)]
mod tests {
    use super::{
        editor_argv, external_terminal_argv, parse_tmux_attach, resolve_editor_target, server_argv,
        ExternalTerminal,
    };
    use std::fs;

    #[test]
    fn editor_config_remains_structured_argv() {
        let target = std::path::Path::new("/tmp/a file;touch nope");
        let (program, args) =
            editor_argv(Some(r#"["code","--reuse-window","--goto"]"#), target).unwrap();
        assert_eq!(program, "code");
        assert_eq!(
            args,
            vec!["--reuse-window", "--goto", "/tmp/a file;touch nope"]
        );
    }

    #[test]
    fn server_command_is_fixed_and_argv_only() {
        let (program, args) = server_argv();
        assert!(program.ends_with("/node_modules/.bin/tsx"));
        assert!(args[0].ends_with("/packages/server/src/main.ts"));
        assert_eq!(args[1], "start");
    }

    #[test]
    fn allows_only_fixed_iterm_terminal_and_wezterm_adapters() {
        let attach = "tmux -L coolie attach -t coolie-w1";
        let (program, args) = external_terminal_argv(ExternalTerminal::Iterm2, attach).unwrap();
        assert_eq!(program, "/usr/bin/osascript");
        assert_eq!(args[0], "-e");
        assert!(args[1].contains(attach));

        let (program, args) = external_terminal_argv(ExternalTerminal::Terminal, attach).unwrap();
        assert_eq!(program, "/usr/bin/osascript");
        assert_eq!(args[0], "-e");
        assert!(args[1].contains(attach));

        let (program, args) = external_terminal_argv(ExternalTerminal::Wezterm, attach).unwrap();
        assert_eq!(program, "/Applications/WezTerm.app/Contents/MacOS/wezterm");
        assert_eq!(
            args,
            vec![
                "start",
                "--",
                "tmux",
                "-L",
                "coolie",
                "attach",
                "-t",
                "coolie-w1"
            ]
        );
    }

    #[test]
    fn denies_shell_wrappers_placeholders_and_extra_flags_for_every_adapter() {
        let attacks = [
            "tmux -L coolie attach -t coolie-w1 -- /bin/sh -lc touch-pwn",
            "tmux -L {cmd} attach -t coolie-w1",
            "tmux -L coolie attach -t coolie-{cmd}",
            "tmux -L coolie -f /tmp/evil attach -t coolie-w1",
            "tmux -L coolie attach -t coolie-w1 --",
        ];
        for attack in attacks {
            for terminal in [
                ExternalTerminal::Iterm2,
                ExternalTerminal::Terminal,
                ExternalTerminal::Wezterm,
            ] {
                assert!(
                    external_terminal_argv(terminal, attack).is_err(),
                    "{attack}"
                );
            }
        }
        assert!(parse_tmux_attach("tmux -L coolie attach -t other-w1").is_err());
    }

    #[test]
    fn rejects_custom_and_executable_path_terminal_ids_including_symlinks() {
        assert!(serde_json::from_str::<ExternalTerminal>(r#""custom""#).is_err());
        let base =
            std::env::temp_dir().join(format!("coolie-terminal-id-test-{}", std::process::id()));
        fs::create_dir_all(&base).unwrap();
        let symlink = base.join("wezterm");
        #[cfg(unix)]
        std::os::unix::fs::symlink("/bin/sh", &symlink).unwrap();
        let encoded = serde_json::to_string(symlink.to_str().unwrap()).unwrap();
        assert!(serde_json::from_str::<ExternalTerminal>(&encoded).is_err());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn rejects_traversal_and_symlink_escape() {
        let base = std::env::temp_dir().join(format!(
            "coolie-editor-test-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("unnamed")
        ));
        let workspace = base.join("workspace");
        let outside = base.join("outside.txt");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(&outside, "outside").unwrap();
        assert_eq!(
            resolve_editor_target(workspace.to_str().unwrap(), "../outside.txt")
                .unwrap_err()
                .code,
            "invalid_relative_path"
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, workspace.join("link")).unwrap();
            assert_eq!(
                resolve_editor_target(workspace.to_str().unwrap(), "link")
                    .unwrap_err()
                    .code,
                "path_outside_workspace"
            );
        }
        fs::remove_dir_all(&base).unwrap();
    }
}
