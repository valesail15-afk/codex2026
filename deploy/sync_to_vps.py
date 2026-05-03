#!/usr/bin/env python3
"""
同步当前项目到 VPS，并默认把本地 arbitrage.db 同步到线上运行库。

用法示例：
python deploy/sync_to_vps.py --host 43.255.156.54 --user root --password YOUR_PASSWORD
"""

from __future__ import annotations

import argparse
import fnmatch
import posixpath
import sys
import time
from pathlib import Path

try:
    import paramiko
except ImportError as exc:  # pragma: no cover
    raise SystemExit("缺少依赖 paramiko，请先执行: pip install paramiko") from exc


EXCLUDE_PATTERNS = [
    ".git/*",
    ".git",
    "node_modules/*",
    "node_modules",
    "dist/*",
    "dist",
    "qa-artifacts/*",
    "qa-artifacts",
    "deploy/__pycache__/*",
    "deploy/__pycache__",
    "*.log",
    ".tmp-*",
]


def safe_print(*parts: object) -> None:
    text = " ".join(str(part) for part in parts)
    try:
        print(text)
    except UnicodeEncodeError:
        sys.stdout.buffer.write(text.encode("utf-8", errors="replace") + b"\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="同步 AFK 项目到 VPS，并默认同步运行数据库")
    parser.add_argument("--host", required=True, help="VPS 主机地址")
    parser.add_argument("--user", required=True, help="SSH 用户名")
    parser.add_argument("--password", required=True, help="SSH 密码")
    parser.add_argument("--port", type=int, default=22, help="SSH 端口，默认 22")
    parser.add_argument("--remote-dir", default="/opt/afk", help="远程项目目录，默认 /opt/afk")
    parser.add_argument("--local-dir", default=".", help="本地项目目录，默认当前目录")
    parser.add_argument(
        "--skip-build",
        action="store_true",
        help="只同步文件，不执行远程 docker compose up -d --build",
    )
    parser.add_argument(
        "--skip-runtime-db",
        action="store_true",
        help="跳过把本地 arbitrage.db 同步到远程 data/arbitrage.db",
    )
    return parser.parse_args()


def should_exclude(rel_path: str) -> bool:
    normalized = rel_path.replace("\\", "/")
    return any(fnmatch.fnmatch(normalized, pattern) for pattern in EXCLUDE_PATTERNS)


def ensure_remote_dir(sftp: paramiko.SFTPClient, remote_dir: str) -> None:
    parts = []
    current = remote_dir
    while current not in ("", "/"):
        parts.append(current)
        current = posixpath.dirname(current)
    for directory in reversed(parts):
        try:
            sftp.stat(directory)
        except FileNotFoundError:
            sftp.mkdir(directory)


def upload_tree(sftp: paramiko.SFTPClient, local_root: Path, remote_root: str) -> int:
    uploaded = 0
    for path in sorted(local_root.rglob("*")):
        rel = path.relative_to(local_root)
        rel_str = rel.as_posix()
        if should_exclude(rel_str):
            continue
        remote_path = posixpath.join(remote_root, rel_str)
        if path.is_dir():
            ensure_remote_dir(sftp, remote_path)
            continue
        ensure_remote_dir(sftp, posixpath.dirname(remote_path))
        sftp.put(str(path), remote_path)
        uploaded += 1
    return uploaded


def remote_exists(sftp: paramiko.SFTPClient, remote_path: str) -> bool:
    try:
        sftp.stat(remote_path)
        return True
    except FileNotFoundError:
        return False


def run(ssh: paramiko.SSHClient, command: str, timeout: int = 240) -> str:
    stdin, stdout, stderr = ssh.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="ignore")
    err = stderr.read().decode("utf-8", errors="ignore")
    if stdout.channel.recv_exit_status() != 0:
        raise RuntimeError(f"命令执行失败: {command}\n{err or out}")
    return out.strip()


def backup_remote_file(ssh: paramiko.SSHClient, remote_path: str) -> str:
    suffix = time.strftime("%Y%m%d-%H%M%S")
    backup_path = f"{remote_path}.bak-{suffix}"
    run(ssh, f"if [ -f {remote_path} ]; then cp {remote_path} {backup_path}; fi")
    return backup_path


def main() -> int:
    args = parse_args()
    local_root = Path(args.local_dir).resolve()
    local_db = local_root / "arbitrage.db"
    if not local_root.exists():
        raise SystemExit(f"本地目录不存在: {local_root}")
    if not local_db.exists():
        raise SystemExit(f"缺少本地数据库文件: {local_db}")

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(
        hostname=args.host,
        port=args.port,
        username=args.user,
        password=args.password,
        timeout=20,
    )

    try:
        sftp = ssh.open_sftp()
        remote_dir = args.remote_dir.rstrip("/")
        runtime_db = f"{remote_dir}/data/arbitrage.db"
        project_db = f"{remote_dir}/arbitrage.db"

        safe_print(f"[1/5] 确保远程目录存在: {remote_dir}")
        ensure_remote_dir(sftp, remote_dir)
        ensure_remote_dir(sftp, f"{remote_dir}/data")

        safe_print("[2/5] 同步项目文件")
        uploaded = upload_tree(sftp, local_root, remote_dir)
        safe_print(f"已上传文件数: {uploaded}")

        safe_print("[3/5] 同步数据库")
        if remote_exists(sftp, runtime_db):
            backup_path = backup_remote_file(ssh, runtime_db)
            safe_print(f"已备份线上运行库: {backup_path}")
        sftp.put(str(local_db), project_db)
        safe_print(f"已同步项目根数据库: {project_db}")
        if not args.skip_runtime_db:
            sftp.put(str(local_db), runtime_db)
            safe_print(f"已同步线上运行数据库: {runtime_db}")

        sftp.close()

        safe_print("[4/5] 校验线上运行库挂载")
        mounts = run(ssh, "docker inspect afk-app --format '{{json .Mounts}}' || true", timeout=60)
        if mounts:
            safe_print(mounts)

        if not args.skip_build:
            safe_print("[5/5] 重启线上服务")
            try:
                # 尝试 docker compose (原有逻辑)
                safe_print("尝试使用 docker compose 重启...")
                run(ssh, f"cd {remote_dir} && docker compose up -d --build", timeout=600)
                safe_print(run(ssh, "docker ps --format '{{.Names}} {{.Status}} {{.Ports}}'", timeout=60))
            except RuntimeError as e:
                if "docker: command not found" in str(e) or "docker-compose: command not found" in str(e):
                    safe_print("VPS 未安装 Docker，尝试使用 pm2 或直接进程重启...")
                    
                    # 尝试 pm2
                    pm2_check = run(ssh, "pm2 -v || echo 'not found'", timeout=20)
                    if "not found" not in pm2_check:
                        safe_print(f"检测到 PM2 (版本: {pm2_check})，尝试 pm2 reload...")
                        run(ssh, f"cd {remote_dir} && pm2 reload deploy/ecosystem.config.cjs || pm2 start deploy/ecosystem.config.cjs", timeout=60)
                    else:
                        # 直接杀死旧进程并后台启动
                        safe_print("尝试直接杀死旧进程并使用 tsx 启动...")
                        # 查找并杀死旧进程 (server.ts)
                        ssh.exec_command("pkill -f 'tsx server.ts'")
                        time.sleep(2)
                        # 后台启动 (使用 nohup)
                        start_cmd = f"cd {remote_dir} && nohup ./node_modules/.bin/tsx server.ts > app.log 2>&1 &"
                        ssh.exec_command(start_cmd)
                        safe_print("服务已在后台启动 (nohup)")
                else:
                    raise e
        else:
            safe_print("[5/5] 已跳过远程构建")

    finally:
        ssh.close()

    safe_print("部署同步完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
