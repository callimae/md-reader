use std::fs;
use std::process::Command;

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
fn list_dirs(path: String) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            out.push(entry.file_name().to_string_lossy().to_string());
        }
    }
    out.sort();
    Ok(out)
}

fn git(repo: &str, args: &[&str]) -> Result<std::process::Output, String> {
    // Git for Windows nie zawsze jest w PATH procesu uruchomionego z Eksploratora.
    let candidates = ["git", r"C:\Program Files\Git\cmd\git.exe"];
    let mut last_err = String::from("git not found");
    for exe in candidates {
        let mut cmd = Command::new(exe);
        cmd.current_dir(repo).args(args);
        // Bez tej flagi każde wywołanie gita mignęłoby oknem konsoli.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        match cmd.output() {
            Ok(out) => return Ok(out),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(last_err)
}

fn git_ok(repo: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let out = git(repo, args)?;
    if !out.status.success() {
        let mut msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if msg.is_empty() {
            msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
        }
        return Err(format!("git {}: {}", args.join(" "), msg));
    }
    Ok(out)
}

#[tauri::command]
fn git_publish(repo: String, message: String) -> Result<String, String> {
    let status = git_ok(&repo, &["status", "--porcelain"])?;
    if status.stdout.is_empty() {
        return Ok("nothing".into());
    }
    git_ok(&repo, &["add", "-A"])?;
    git_ok(&repo, &["commit", "-m", &message])?;
    git_ok(&repo, &["push"])?;
    Ok("published".into())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            file_exists,
            list_dirs,
            git_publish
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
