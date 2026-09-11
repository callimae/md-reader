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

#[derive(serde::Serialize)]
struct TreeNode {
    name: String,
    path: String,
    dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<TreeNode>>,
}

// Katalogi generowane/ciężkie, których nie ma sensu pokazywać w drzewie.
const SKIP_DIRS: [&str; 4] = ["node_modules", "target", "public", "resources"];
const TEXT_EXTS: [&str; 3] = ["md", "markdown", "txt"];

fn read_tree(dir: &std::path::Path, depth: u32) -> Vec<TreeNode> {
    if depth > 12 {
        return Vec::new();
    }
    let mut dirs: Vec<TreeNode> = Vec::new();
    let mut files: Vec<TreeNode> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                let children = read_tree(&path, depth + 1);
                // Puste gałęzie (bez żadnego pliku tekstowego) pomijamy.
                if !children.is_empty() {
                    dirs.push(TreeNode {
                        name,
                        path: path.to_string_lossy().to_string(),
                        dir: true,
                        children: Some(children),
                    });
                }
            } else {
                let is_text = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| TEXT_EXTS.contains(&e.to_ascii_lowercase().as_str()))
                    .unwrap_or(false);
                if is_text {
                    files.push(TreeNode {
                        name,
                        path: path.to_string_lossy().to_string(),
                        dir: false,
                        children: None,
                    });
                }
            }
        }
    }
    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    dirs.extend(files);
    dirs
}

#[tauri::command]
fn list_tree(path: String) -> Result<Vec<TreeNode>, String> {
    let p = std::path::Path::new(&path);
    if !p.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    Ok(read_tree(p, 0))
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

#[derive(serde::Serialize)]
struct SearchHit {
    path: String,
    name: String,
    line: u32,
    snippet: String,
}

const SEARCH_LIMIT: usize = 300;

fn search_walk(dir: &std::path::Path, q: &str, hits: &mut Vec<SearchHit>, depth: u32) {
    if depth > 12 || hits.len() >= SEARCH_LIMIT {
        return;
    }
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.flatten() {
            if hits.len() >= SEARCH_LIMIT {
                return;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                search_walk(&path, q, hits, depth + 1);
            } else {
                let is_text = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| TEXT_EXTS.contains(&e.to_ascii_lowercase().as_str()))
                    .unwrap_or(false);
                if !is_text {
                    continue;
                }
                if let Ok(content) = fs::read_to_string(&path) {
                    for (i, line) in content.lines().enumerate() {
                        if line.to_lowercase().contains(q) {
                            hits.push(SearchHit {
                                path: path.to_string_lossy().to_string(),
                                name: name.clone(),
                                line: (i + 1) as u32,
                                snippet: line.trim().chars().take(120).collect(),
                            });
                            if hits.len() >= SEARCH_LIMIT {
                                return;
                            }
                        }
                    }
                }
            }
        }
    }
}

#[tauri::command]
fn search_files(root: String, query: String) -> Result<Vec<SearchHit>, String> {
    let q = query.to_lowercase();
    let mut hits = Vec::new();
    if q.chars().count() >= 2 {
        search_walk(std::path::Path::new(&root), &q, &mut hits, 0);
    }
    Ok(hits)
}

#[tauri::command]
fn startup_file() -> Option<String> {
    std::env::args()
        .nth(1)
        .filter(|a| std::path::Path::new(a).is_file())
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
            list_tree,
            search_files,
            startup_file,
            git_publish
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
