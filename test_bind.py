import socket

s = socket.socket()
s.bind(("127.0.0.1", 5000))  # 0=让系统随便分配一个端口
print("bound to", s.getsockname())
s.listen(1)
input("OK, press Enter to exit...")
