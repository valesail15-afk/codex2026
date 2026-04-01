import paramiko

host='43.255.156.54'
user='root'
pwd='Omk2cbpfhic6cjD'
files=[
  (r'D:/afk/server.ts','/opt/afk/server.ts'),
  (r'D:/afk/arbitrage.db','/opt/afk/arbitrage.db'),
]

ssh=paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(host,username=user,password=pwd,timeout=20)

sftp=ssh.open_sftp()
for local,remote in files:
  sftp.put(local,remote)
sftp.close()

for cmd in [
  'cd /opt/afk && docker compose up -d --build',
  'cd /opt/afk && docker compose ps',
  'docker logs --tail 80 afk-app'
]:
  stdin,stdout,stderr=ssh.exec_command(cmd,get_pty=True)
  out=stdout.read().decode('utf-8','ignore')
  err=stderr.read().decode('utf-8','ignore')
  text=(out+'\n'+err).encode('ascii','ignore').decode('ascii')
  print('\n===== CMD =====')
  print(cmd)
  print(text[-7000:])

ssh.close()
