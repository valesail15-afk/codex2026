import paramiko

def check_link():
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
        stdin, stdout, stderr = ssh.exec_command("ls -l /opt/afk/current/node_modules")
        print("node_modules link:")
        print(stdout.read().decode())
        
        stdin, stdout, stderr = ssh.exec_command("ls -F /opt/afk/current/node_modules/.bin/tsx")
        print("tsx binary check:")
        print(stdout.read().decode())

    except Exception as e:
        print(f"Error: {e}")
    finally:
        ssh.close()

if __name__ == "__main__":
    check_link()
