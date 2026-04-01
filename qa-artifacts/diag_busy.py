import paramiko, time
host='43.255.156.54';user='root';pwd='Omk2cbpfhic6cjD'
ssh=paramiko.SSHClient();ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy());ssh.connect(host,username=user,password=pwd,timeout=20)
checks=[
  "docker exec afk-app sh -lc 'date; top -bn1 | head -n 8'",
  "docker exec afk-app node -e \"const c=AbortSignal.timeout(5000);fetch('http://127.0.0.1:3001',{signal:c}).then(r=>console.log('status',r.status)).catch(e=>console.log('err',e.name,e.message));\""
]
for c in checks:
  i,o,e=ssh.exec_command(c)
  print('===== '+c+' =====')
  print(o.read().decode('utf-8','ignore'))
  print(e.read().decode('utf-8','ignore'))
print('---sleep 20s---')
time.sleep(20)
for c in ["docker logs --tail 40 afk-app","docker exec afk-app node -e \"const c=AbortSignal.timeout(5000);fetch('http://127.0.0.1:3001',{signal:c}).then(r=>console.log('status',r.status)).catch(e=>console.log('err',e.name,e.message));\""]:
  i,o,e=ssh.exec_command(c)
  print('===== '+c+' =====')
  print(o.read().decode('utf-8','ignore'))
  print(e.read().decode('utf-8','ignore'))
ssh.close()
