#!/usr/bin/env python3
"""Cuts demo/out/{jam.mp4,web.webm,card-*.png} into demo/out/DownBeat-demo.mp4 (1080p30, captions)."""
import os, shutil, subprocess, sys

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else 'out')
SEG = os.path.join(OUT, 'segments')
shutil.rmtree(SEG, ignore_errors=True)
os.makedirs(SEG)
FONT = os.path.join(OUT, 'font.ttf')
if not os.path.exists(FONT):
    src = subprocess.check_output(['fc-match', 'Google Sans:weight=500', '-f', '%{file}'], text=True).strip()
    shutil.copy(src, FONT)

ENC = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', '30',
       '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2']
segments = []


def caption_filters(captions):
    """captions: list of (start, end, text) relative to the segment. Returns drawtext filters."""
    out = []
    for i, (a, b, text) in enumerate(captions):
        path = os.path.join(SEG, f'cap{len(segments)}_{i}.txt')
        open(path, 'w').write(text)
        out.append(f"drawtext=fontfile={FONT}:textfile={path}:fontsize=40:fontcolor=white:"
                   f"box=1:boxcolor=0x0b0f17@0.82:boxborderw=26:x=(w-tw)/2:y=h-140:"
                   f"enable='between(t,{a},{b})':alpha='min(1,min((t-{a})/0.3,({b}-t)/0.3))'")
    return out


def card(name, seconds):
    path = os.path.join(SEG, f'{len(segments):02d}-card-{name}.mp4')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-loop', '1', '-t', str(seconds), '-i', os.path.join(OUT, f'card-{name}.png'),
                    '-f', 'lavfi', '-t', str(seconds), '-i', 'anullsrc=r=48000:cl=stereo',
                    '-vf', f'fade=in:0:12,fade=out:st={seconds - 0.4}:d=0.4,format=yuv420p', *ENC, '-shortest', path], check=True)
    segments.append(path)


def clip(src, start, end, captions=(), speed=1.0, gain_db=0.0, mute=False, crop_plugin=False):
    path = os.path.join(SEG, f'{len(segments):02d}-clip.mp4')
    vf = []
    if crop_plugin:  # drop the desktop bar on the left of the recording, keep both plugin windows
        vf.append('crop=1776:999:72:40,scale=1920:1080:flags=lanczos')
    else:
        vf.append('scale=1920:1080:flags=lanczos')
    if speed != 1.0:
        vf.append(f'setpts=PTS/{speed}')
    vf.append('fps=30')
    vf += caption_filters(captions)
    duration = (end - start) / speed
    args = ['ffmpeg', '-v', 'error', '-y', '-ss', str(start), '-t', str(end - start), '-i', src]
    if mute or speed != 1.0:
        args += ['-f', 'lavfi', '-t', str(duration), '-i', 'anullsrc=r=48000:cl=stereo',
                 '-filter_complex', f"[0:v]{','.join(vf)}[v]", '-map', '[v]', '-map', '1:a']
    else:
        args += ['-filter_complex', f"[0:v]{','.join(vf)}[v];[0:a]volume={gain_db}dB,afade=in:d=0.15,afade=out:st={duration - 0.25}:d=0.25[a]",
                 '-map', '[v]', '-map', '[a]']
    subprocess.run(args + [*ENC, '-t', str(duration), path], check=True)
    segments.append(path)


JAM = os.path.join(OUT, 'jam.mp4')
WEB = os.path.join(OUT, 'web.webm')

card('intro', 4.5)
card('jam', 3.5)
clip(JAM, 2.0, 15.5, crop_plugin=True, captions=[
    (0.3, 6.5, 'Maya and Leo pair their plugins with their DownBeat accounts'),
    (6.8, 13.3, 'Both join one session: audio connects peer-to-peer, 48 kHz / 24-bit'),
])
clip(JAM, 15.5, 31.0, crop_plugin=True, gain_db=18, captions=[
    (0.3, 7.5, 'One shared MIDI clip: Maya writes the bassline, Leo the melody'),
    (7.8, 15.3, 'Every edit syncs live and plays in each DAW, in time with its transport'),
])
clip(JAM, 31.0, 55.0, crop_plugin=True, gain_db=-2, captions=[
    (0.3, 11.5, 'Beat Jam: Lyria RealTime streams AI music, locked to the session tempo and key'),
    (11.8, 23.8, 'Prompt: "dusty lo-fi hip hop drums, warm Rhodes chords" - heard in both plugins'),
])
clip(JAM, 57.5, 61.0, crop_plugin=True, mute=True, captions=[
    (0.2, 3.5, 'Credits Agent: Gemini drafts a split from the session activity log'),
])
clip(JAM, 61.0, 81.0, crop_plugin=True, speed=10.0, captions=[
    (0.0, 2.0, 'Gemini is reading the session log (sped up 10x)'),
])
clip(JAM, 81.0, 90.0, crop_plugin=True, mute=True, captions=[
    (0.2, 9.0, 'The proposal: who did what, a suggested split and an AI-use disclosure'),
])
clip(JAM, 119.5, 127.5, crop_plugin=True, mute=True, captions=[
    (0.2, 8.0, 'Both collaborators approve, and the split sheet becomes final'),
])
card('web', 3.5)
clip(WEB, 0.0, 9.6, mute=True, captions=[(0.3, 9.4, 'Live now at downbeat-919f8.web.app')])
clip(WEB, 9.6, 15.2, mute=True, captions=[(0.2, 5.6, 'Dashboard: sessions, paired plugins and AI reports')])
clip(WEB, 15.2, 28.2, mute=True, captions=[
    (0.2, 6.4, 'Who is online and who did what, measured by the plugin'),
    (6.6, 13.0, 'Every action is kept in a Yjs CRDT log, which the Credits Agent reads'),
])
clip(WEB, 28.2, 36.7, mute=True, captions=[(0.2, 8.5, 'Final split sheet PDF, approved by both, with AI disclosure')])
card('outro', 5.0)

listing = os.path.join(SEG, 'list.txt')
open(listing, 'w').write(''.join(f"file '{p}'\n" for p in segments))
joined = os.path.join(SEG, 'joined.mp4')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listing, '-c', 'copy', joined], check=True)
final = os.path.join(OUT, 'DownBeat-demo.mp4')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', joined, '-c:v', 'copy', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
                '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', final], check=True)
print('wrote', final)
