import paramiko
import sys

def run_remote():
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
        # Check what processes are running
        stdin, stdout, stderr = ssh.exec_command("ps aux | grep -E 'node|tsx|pm2'")
        print("Running processes:")
        print(stdout.read().decode())
        
        # Check if pm2 is installed
        stdin, stdout, stderr = ssh.exec_command("pm2 -v")
        pm2_version = stdout.read().decode().strip()
        if pm2_version:
            print(f"PM2 Version: {pm2_version}")
        else:
            print("PM2 not found")

    except Exception as e:
        print(f"Error: {e}")
    finally:
        ssh.close()

if __name__ == "__main__":
    run_remote()
