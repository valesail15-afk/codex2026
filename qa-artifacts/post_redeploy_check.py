import paramiko,time
host='43.255.156.54';user='root';pwd='Omk2cbpfhic6cjD'
ssh=paramiko.SSHClient();ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy());ssh.connect(host,username=user,password=pwd,timeout=20)
time.sleep(6)
for cmd in [
  'docker logs --tail 120 afk-app',
  "docker exec afk-app node -e \"const c=AbortSignal.timeout(5000);fetch('http://127.0.0.1:3001',{signal:c}).then(r=>console.log('status',r.status)).catch(e=>console.log('err',e.name,e.message));\"",
  "docker exec afk-app sh -lc 'top -bn1 | head -n 8'"
]:
  i,o,e=ssh.exec_command(cmd)
  print('===== '+cmd+' =====')
  print(o.read().decode('utf-8','ignore'))
  print(e.read().decode('utf-8','ignore'))
ssh.close()
