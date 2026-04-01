import paramiko
host='43.255.156.54';user='root';pwd='Omk2cbpfhic6cjD'
ssh=paramiko.SSHClient();ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy());ssh.connect(host,username=user,password=pwd,timeout=20)
cmds=[
  "docker logs --tail 200 afk-app",
  "docker exec afk-app ps -ef",
  "docker exec afk-app sh -lc 'ss -lntp | grep 3001 || true'",
  "docker exec afk-app sh -lc 'node -e \"console.log(process.env.NODE_ENV)\"'"
]
for c in cmds:
  i,o,e=ssh.exec_command(c)
  print('===== '+c+' =====')
  print(o.read().decode('utf-8','ignore'))
  print(e.read().decode('utf-8','ignore'))
ssh.close()
