#!/usr/bin/env python3
"""
Records the plugin half of the demo video: two DownBeat Standalones (Maya and Leo) on a
headless Hyprland output, driven by DOWNBEAT_AUTOPILOT scripts against the local dev server.

  python3 demo/record_jam.py OUTDIR      (needs: local server on :8088 with dev tokens, a
                                          Hyprland headless output named DEMO on workspace 1)
Writes OUTDIR/jam.mp4 (video + system audio) and OUTDIR/jam-steps.json (timestamps of each step).
"""
import json, os, re, signal, subprocess, sys, time, urllib.request

SERVER = 'http://localhost:8088'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else 'out')
os.makedirs(OUT, exist_ok=True)


def api(method, path, who, body=None):
    req = urllib.request.Request(SERVER + path, method=method,
                                 headers={'Authorization': f'Bearer dev-mock-token-{who}', 'Content-Type': 'application/json'},
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


existing_pids = {c['pid'] for c in json.loads(subprocess.check_output(['hyprctl', 'clients', '-j']))}


def take():
    session = api('POST', '/sessions', 'maya', {'name': 'Midnight Groove', 'bpm': 96, 'keySignature': 'A min'})['session']
    code = session['inviteCode']
    print('session', session['id'], 'invite', code)

    # Delays are milliseconds after the previous step.
    SAM = f"""
    10 mic off
    1490 click signIn
    5000 type inviteCode {code}
    900 click join
    3500 note 0 6 57 115
    700 note 16 6 53 115
    700 note 32 6 48 115
    700 note 48 6 55 115
    900 preview on
    16000 click agentsTab
    1500 type beatJamPrompt dusty lo-fi hip hop drums, warm Rhodes chords
    1800 click beatJamStart
    22000 click beatJamStop
    600 preview off
    1500 click credits
    62000 click approveCredits
    800 mic on
    8200 quit
    """
    ALEX = f"""
    10 mic off
    1490 click signIn
    6500 type inviteCode {code}
    900 click join
    9000 note 2 2 69 100
    600 note 6 2 67 100
    600 note 10 4 64 105
    700 note 20 2 65 100
    600 note 24 4 69 100
    700 note 36 2 67 100
    600 note 40 2 71 105
    600 note 44 4 67 100
    700 note 52 2 62 100
    600 note 56 6 64 100
    6000 click agentsTab
    88500 click approveCredits
    800 mic on
    7200 quit
    """

    procs, logs = {}, {}
    for who, script in (('maya', SAM), ('leo', ALEX)):
        path = os.path.join(OUT, f'autopilot-{who}.txt')
        open(path, 'w').write(script)
        logs[who] = os.path.join(OUT, f'plugin-{who}.log')
        open(logs[who], 'w').close()

    monitor = subprocess.check_output(['pactl', 'get-default-sink'], text=True).strip() + '.monitor'
    video = os.path.join(OUT, 'jam.mp4')
    rec = subprocess.Popen(['wf-recorder', '-y', '-o', 'DEMO', '-r', '30', f'--audio={monitor}', '-f', video],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    t0 = time.time()
    time.sleep(1.5)

    positions = {'maya': (110, 110), 'leo': (1010, 110)}
    demo = next(m for m in json.loads(subprocess.check_output(['hyprctl', 'monitors', '-j'])) if m['name'] == 'DEMO')
    known = set(existing_pids)
    pids = {}
    for who in ('maya', 'leo'):
        x, y = positions[who]
        cmd = f'{HERE}/launch-plugin.sh demo-{who} {OUT}/autopilot-{who}.txt {logs[who]}'
        lua = f'hl.dsp.exec_cmd("{cmd}", {{workspace="1 silent", float=true, move="{x} {y}"}})'
        subprocess.run(['hyprctl', 'dispatch', lua], check=True, stdout=subprocess.DEVNULL)
        for _ in range(50):
            new = [c['pid'] for c in json.loads(subprocess.check_output(['hyprctl', 'clients', '-j']))
                   if c['title'] == 'DownBeat' and c['pid'] not in known]
            if new:
                pids[who] = new[0]; known.add(new[0]); break
            time.sleep(0.1)
    if len(pids) < 2:
        print('a plugin window did not appear'); rec.send_signal(signal.SIGINT); rec.wait(timeout=30)
        for p in pids.values(): os.kill(p, signal.SIGTERM)
        return False

    # Hyprland sometimes repositions a floating window when it resizes (sign-in shrinks the editor),
    # which can push it off the DEMO output. Pin both windows every half second.
    def pin():
        clients = {c['pid']: c for c in json.loads(subprocess.check_output(['hyprctl', 'clients', '-j']))}
        for who, pid in pids.items():
            c = clients.get(pid)
            if c is None:
                continue
            gx, gy = demo['x'] + positions[who][0], demo['y'] + positions[who][1]
            if c['workspace']['name'] != '1':
                subprocess.run(['hyprctl', 'dispatch', f'hl.dsp.window.move({{ workspace = 1, window = "pid:{pid}" }})'], stdout=subprocess.DEVNULL)
            if c['at'] != [gx, gy]:
                subprocess.run(['hyprctl', 'dispatch', f'hl.dsp.window.move({{ x = {gx}, y = {gy}, relative = false, window = "pid:{pid}" }})'], stdout=subprocess.DEVNULL)
    pin()
    last_pin = time.time()

    steps, offsets, paired, done = [], {w: 0 for w in logs}, set(), set()
    deadline = time.time() + 240
    while time.time() < deadline and len(done) < 2:
        if time.time() - last_pin > 0.5 and len(done) == 0:
            pin(); last_pin = time.time()
        for who, path in logs.items():
            with open(path) as f:
                f.seek(offsets[who]); chunk = f.read(); offsets[who] = f.tell()
            for line in chunk.splitlines():
                if not line.startswith('DOWNBEAT_AUTOPILOT'):
                    continue
                msg = line.split(' ', 1)[1]
                steps.append({'t': round(time.time() - t0, 2), 'who': who, 'msg': msg})
                print(f'{steps[-1]["t"]:7.2f}  {who:5} {msg}')
                m = re.match(r'pair-code (\S+)', msg)
                if m and who not in paired:
                    r = urllib.request.Request(SERVER + '/auth/pair/confirm', method='POST', headers={'Content-Type': 'application/json'},
                                               data=json.dumps({'code': m.group(1), 'idToken': f'dev-mock-token-{who}'}).encode())
                    urllib.request.urlopen(r, timeout=15).read()
                    paired.add(who)
                if msg.startswith('step quit'):
                    done.add(who)
        time.sleep(0.2)

    time.sleep(1.0)
    rec.send_signal(signal.SIGINT)
    rec.wait(timeout=30)
    json.dump({'session': session, 'steps': steps}, open(os.path.join(OUT, 'jam-steps.json'), 'w'), indent=1)
    print('recorded', video)
    return True


for attempt in range(3):
    if take():
        break
else:
    sys.exit('could not place both plugin windows on the DEMO output')
