# MeTube REPL Mode - Interactive Shell

## What is REPL Mode?

Like Gemini CLI or GitHub Copilot CLI, MeTube now has an **interactive mode** where you launch once and run multiple commands.

## Usage

### Launch REPL
```bash
metube
```

You'll see:
```
███╗   ███╗███████╗████████╗██╗   ██╗██████╗ ███████╗
████╗ ████║██╔════╝╚══██╔══╝██║   ██║██╔══██╗██╔════╝
██╔████╔██║█████╗     ██║   ██║   ██║██████╔╝█████╗  
██║╚██╔╝██║██╔══╝     ██║   ██║   ██║██╔══██╗██╔══╝  
██║ ╚═╝ ██║███████╗   ██║   ╚██████╔╝██████╔╝███████╗
╚═╝     ╚═╝╚══════╝   ╚═╝    ╚═════╝ ╚═════╝ ╚══════╝

YouTube Video Extraction & Analysis CLI • Interactive Mode

Type help or /help for commands • exit or Ctrl+C to quit

metube> _
```

### Run Commands Inside
```
metube> init
metube> playlist list
metube> playlist discover
metube> extract playlist PLxxx...
metube> help
metube> exit
```

## REPL Commands

### Standard Commands
All normal commands work:
- `init` - OAuth authentication
- `playlist list` - List playlists
- `playlist discover` - Interactive picker
- `playlist add <id>` - Add playlist
- `playlist remove <id>` - Remove playlist
- `extract playlist <id>` - Extract videos
- `extract video <id>` - Extract single video
- `report playlist <id>` - Generate report

### REPL-Specific Commands
- `/help` or `help` - Show help
- `/clear` or `clear` - Clear screen
- `/history` - Show command history
- `/exit` or `exit` or `quit` - Exit REPL
- `Ctrl+C` - Exit REPL

### Command History
- `↑` - Previous command
- `↓` - Next command

## Direct Command Mode (Still Works)

You can still run single commands directly:

```bash
metube init
metube playlist list
metube extract playlist PLxxx...
```

## Comparison

### Old Way (Repetitive)
```bash
$ metube init
...output...
$ metube playlist list
...output...
$ metube playlist discover
...output...
$ metube extract playlist PLxxx
...output...
```

### New Way (REPL)
```bash
$ metube
metube> init
...output...
metube> playlist list
...output...
metube> discover
...output...
metube> extract playlist PLxxx
...output...
metube> exit
$
```

## Features

✅ **Command history** - Use arrow keys to recall previous commands
✅ **Persistent session** - No need to retype `metube` each time
✅ **Auto-complete** - Type tab for suggestions (coming soon)
✅ **Slash commands** - `/help`, `/clear`, `/history`
✅ **Gradient banner** - Rainbow "MeTube" logo
✅ **Help on demand** - Shows help on first launch

## Known Limitations

**Current Issue:** Command output may create separate Ink instances. This means interactive commands (like `playlist discover`) might not display properly in REPL mode yet.

**Workaround:** Use direct command mode for interactive commands:
```bash
# In shell (not REPL)
metube playlist discover
```

**Future:** Will refactor command architecture to work seamlessly in both modes.

## Examples

### Quick Check
```bash
metube
metube> init
metube> playlist list
metube> exit
```

### Interactive Session
```bash
metube
metube> init
metube> help
metube> playlist list
metube> /history
metube> clear
metube> exit
```

### Mixed Usage
```bash
# Quick check in REPL
metube
metube> init
metube> exit

# Then use direct mode for interactive commands
metube playlist discover
metube extract playlist PLxxx...
```

## Tips

1. **Start with REPL** for exploratory work and checking status
2. **Use direct mode** for scripting and automation
3. **Press ↑** to repeat long commands
4. **Type `/help`** anytime you forget commands
5. **Use `Ctrl+C`** for quick exit

## Technical Details

- Built with Ink + React
- Persistent command history
- Gradient text using `ink-gradient`
- ASCII art using `ink-big-text`
- Text input using `ink-text-input`
- Orange/grey color scheme throughout

## Future Enhancements

- [ ] Tab completion
- [ ] Command aliases (e.g., `pl` for `playlist`)
- [ ] Better output handling in REPL
- [ ] Session save/restore
- [ ] Keybindings customization
- [ ] Config file support
