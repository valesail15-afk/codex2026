import paramiko
host='43.255.156.54';user='root';pwd='Omk2cbpfhic6cjD'
ssh=paramiko.SSHClient();ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy());ssh.connect(host,username=user,password=pwd,timeout=20)
sftp=ssh.open_sftp();sftp.put(r'D:/afk/server.ts','/opt/afk/server.ts');sftp.close()
for cmd in ['cd /opt/afk && docker compose up -d --build','docker logs --tail 40 afk-app']:
  i,o,e=ssh.exec_command(cmd,get_pty=True)
  txt=(o.read().decode('utf-8','ignore')+'\n'+e.read().decode('utf-8','ignore')).encode('ascii','ignore').decode('ascii')
  print(txt[-5000:])
ssh.close()
