import paramiko
import time

def force_restart():
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
        
        print("Killing old processes...")
        # Kill all node processes related to server.ts
        ssh.exec_command("ps aux | grep 'server.ts' | grep -v grep | awk '{print $2}' | xargs kill -9")
        time.sleep(3)
        
        print("Starting new process from /opt/afk/current...")
        # Use the absolute path to tsx in node_modules
        start_cmd = "cd /opt/afk/current && nohup ./node_modules/.bin/tsx server.ts > ../app.log 2>&1 &"
        ssh.exec_command(start_cmd)
        
        time.sleep(5)
        stdin, stdout, stderr = ssh.exec_command("ps aux | grep 'server.ts' | grep -v grep")
        print("Current processes:")
        print(stdout.read().decode())
        
        stdin, stdout, stderr = ssh.exec_command("tail -n 10 /opt/afk/app.log")
        print("Recent logs:")
        print(stdout.read().decode())

    except Exception as e:
        print(f"Error: {e}")
    finally:
        ssh.close()

if __name__ == "__main__":
    force_restart()
