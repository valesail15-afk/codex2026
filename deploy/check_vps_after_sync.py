import paramiko
import sys

def check_remote():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect(
            hostname='156.226.22.101',
            port=24125,
            username='root',
            password='tzNO4WnKXgbO',
            timeout=20,
        )
        stdin, stdout, stderr = ssh.exec_command("find /opt/afk -maxdepth 1 | wc -l")
        print(f"File count in /opt/afk: {stdout.read().decode().strip()}")
        
        stdin, stdout, stderr = ssh.exec_command("ps aux | grep -E 'tsx server.ts' | grep -v grep")
        print("Current app processes:")
        print(stdout.read().decode())

    except Exception as e:
        print(f"Error: {e}")
    finally:
        ssh.close()

if __name__ == "__main__":
    check_remote()
