import paramiko
import time

def deploy_release():
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
        
        new_release_name = time.strftime("%Y%m%d%H%M%S")
        new_release_path = f"/opt/afk/releases/{new_release_name}"
        
        print(f"Creating new release: {new_release_name}")
        ssh.exec_command(f"mkdir -p {new_release_path}")
        
        # Copy files from /opt/afk (where we uploaded) to the new release
        # Exclude node_modules, releases, backups, data, etc.
        exclude_args = "--exclude=releases --exclude=backups --exclude=data --exclude=logs --exclude=node_modules"
        copy_cmd = f"rsync -av {exclude_args} /opt/afk/ {new_release_path}/"
        print("Copying files to release folder...")
        stdin, stdout, stderr = ssh.exec_command(copy_cmd)
        stdout.read() # wait
        
        # Symlink node_modules from the latest release
        print("Symlinking node_modules...")
        link_nm_cmd = f"ln -s /opt/afk/releases/20260501164903/node_modules {new_release_path}/node_modules"
        ssh.exec_command(link_nm_cmd)
        
        # Update current symlink
        print("Updating 'current' symlink...")
        ssh.exec_command(f"rm -f /opt/afk/current && ln -s {new_release_path} /opt/afk/current")
        
        # Restart service
        print("Restarting service...")
        ssh.exec_command("pkill -f 'tsx server.ts'")
        time.sleep(2)
        start_cmd = f"cd /opt/afk/current && nohup ./node_modules/.bin/tsx server.ts > ../app.log 2>&1 &"
        ssh.exec_command(start_cmd)
        
        time.sleep(5)
        stdin, stdout, stderr = ssh.exec_command("ps aux | grep 'tsx server.ts' | grep -v grep")
        print("Processes after restart:")
        print(stdout.read().decode())
        
        print("Deployment complete.")

    except Exception as e:
        print(f"Error: {e}")
    finally:
        ssh.close()

if __name__ == "__main__":
    deploy_release()
