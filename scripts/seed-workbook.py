#!/usr/bin/env python3
"""Import the supplied workbook through the same preview/commit APIs as the UI.
Only creates a new empty project, or reuses the same empty project. Never replaces.
"""
import json, pathlib, urllib.request, http.cookiejar, urllib.error, sys
root=pathlib.Path(__file__).resolve().parent.parent
cfg=dict(line.split('=',1) for line in (root/'.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
url='http://'+cfg.get('BIND_ADDR','127.0.0.1:8080')+'/api'
opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
release_lease = False
def call(p,body=None):
    req=urllib.request.Request(url+p, data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json','X-Requested-With':'protocol-studio'})
    return json.load(opener.open(req))
try:
    call('/auth/login',{'username':cfg.get('ADMIN_USERNAME','admin'),'password':cfg['ADMIN_PASSWORD']})
    project=next((p for p in call('/projects') if p['name']=='UPM 协议配置'),None)
    if project and project['point_count']:
        print('UPM 项目已有数据，未执行覆盖。');sys.exit(0)
    if not project:project=call('/projects',{'name':'UPM 协议配置','description':'AIDC · 本地控制器与 DSP 点表的统一数据空间'})
    pid=project['id']; boundary='ProtocolWorkbookImport';data=(root/'UPM项目测点数据表.xlsx').read_bytes()
    payload=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="UPM.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n'.encode()+data+f'\r\n--{boundary}--\r\n'.encode())
    req=urllib.request.Request(url+f'/projects/{pid}/imports/preview',data=payload,headers={'Content-Type':f'multipart/form-data; boundary={boundary}','X-Requested-With':'protocol-studio'})
    call(f'/projects/{pid}/edit-lock/acquire', {}); release_lease = True
    preview=json.load(opener.open(req))
    # Commit releases the lease atomically; an unknown response must not release
    # a newer editing session subsequently acquired by the same account.
    release_lease = False
    report=call(f'/projects/{pid}/imports/{preview["id"]}/commit',{'replace':False})
    print(f'已导入 {preview["point_count"]} 个测点；{report["errors"]} 条错误，{report["warnings"]} 条提示。')
except urllib.error.HTTPError as e:
    print(f'HTTP {e.code}: {e.read().decode()}',file=sys.stderr);sys.exit(1)
finally:
    if release_lease:
        try: call(f'/projects/{pid}/edit-lock/release', {})
        except Exception: print('编辑权未能主动释放，将按租约自动过期。', file=sys.stderr)
