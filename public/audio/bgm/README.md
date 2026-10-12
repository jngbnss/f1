# Background music (local only)

Drop a file here named **`bgm1`**, a second one `bgm2`, and so on:

```
public/audio/bgm/bgm1.mp3
public/audio/bgm/bgm2.ogg
```

- Extensions tried, in order: `.mp3`, `.ogg`, `.m4a`, `.wav`, `.opus`. The search
  stops at the first missing number, so the files must be numbered from 1 without gaps.
- For a seamless loop prefer `.ogg` / `.opus`: mp3 encoders pad the start and end with silence.
- Several files: played in a random order, looping the list; `⏭` in the sound panel skips.

Nicer names instead of `bgm<N>`? Add a `tracks.json` and it wins over the convention:

```json
{ "tracks": [{ "src": "song-2.mp3", "title": "Blur — Song 2" }] }
```

- Volume / on-off live in the sound panel (🔊), remembered as `f1:music`. `M` mutes everything.
- The music ducks to 30% while the race engineer talks, and pauses in a background tab.

Everything here except this README is **git-ignored**: these are your own files,
and their licence is not the project's to redistribute. With no files the game is
simply silent and the music row stays hidden.
