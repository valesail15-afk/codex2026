import paramiko
host='43.255.156.54';user='root';pwd='Omk2cbpfhic6cjD'
ssh=paramiko.SSHClient();ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy());ssh.connect(host,username=user,password=pwd,timeout=20)
for cmd in ['curl -I --max-time 10 http://127.0.0.1:3001','curl -I --max-time 10 http://127.0.0.1']:
  i,o,e=ssh.exec_command(cmd)
  print('CMD',cmd)
  print(o.read().decode('utf-8','ignore'))
  print(e.read().decode('utf-8','ignore'))
ssh.close()
