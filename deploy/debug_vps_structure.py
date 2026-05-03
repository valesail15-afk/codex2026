import paramiko

def debug_vps():
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
        stdin, stdout, stderr = ssh.exec_command("ls -la /opt/afk")
        print("Contents of /opt/afk:")
        print(stdout.read().decode())
        
        stdin, stdout, stderr = ssh.exec_command("ls -la /opt/afk/releases")
        print("Contents of /opt/afk/releases:")
        print(stdout.read().decode())
        
        # Check current symlink
        stdin, stdout, stderr = ssh.exec_command("ls -l /opt/afk/current")
        print("Current symlink:")
        print(stdout.read().decode())

    except Exception as e:
        print(f"Error: {e}")
    finally:
        ssh.close()

if __name__ == "__main__":
    debug_vps()
