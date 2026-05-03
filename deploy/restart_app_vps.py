import paramiko
import time

def start_app():
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
        print("Starting app...")
        # The app might need node_modules. Since we uploaded everything to /opt/afk, 
        # let's check if node_modules exists there.
        stdin, stdout, stderr = ssh.exec_command("ls -d /opt/afk/node_modules")
        if stdout.read().decode().strip():
            print("node_modules found.")
        else:
            print("node_modules NOT found in /opt/afk, checking current processes for location...")
            # We saw them in /opt/afk/releases/... earlier. 
            # But we want to run the version we just uploaded to /opt/afk.
            # If node_modules is missing, we might need to run npm install or copy it.
        
        # Start command
        cmd = "cd /opt/afk && nohup ./node_modules/.bin/tsx server.ts > app.log 2>&1 &"
        ssh.exec_command(cmd)
        time.sleep(5)
        
        stdin, stdout, stderr = ssh.exec_command("ps aux | grep 'tsx server.ts' | grep -v grep")
        print("Processes after start:")
        print(stdout.read().decode())
        
        stdin, stdout, stderr = ssh.exec_command("tail -n 20 /opt/afk/app.log")
        print("Recent logs:")
        print(stdout.read().decode())

    except Exception as e:
        print(f"Error: {e}")
    finally:
        ssh.close()

if __name__ == "__main__":
    start_app()
