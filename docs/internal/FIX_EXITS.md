# Exit Handling Fix - Commands Not Exiting

## Problem

All Ink commands hang after completion because they don't call `exit()`.

## Solution Pattern

Add `useApp()` and call `exit()` when done:

```typescript
import { useApp } from 'ink';

export function MyCommand() {
  const { exit } = useApp();
  
  useEffect(() => {
    async function run() {
      // Do work...
      
      // Exit when done
      setTimeout(() => exit(), 2000); // Show output for 2s
    }
    run();
  }, [exit]);
  
  // ...
}
```

## Status

- [x] InitCommand - Fixed
- [ ] PlaylistCommands (all 4 subcommands)
- [ ] ExtractCommand
- [ ] ReportCommand

## Quick Fix

For now, use **REPL mode** which doesn't have this issue:

```bash
mtb
> init
> playlist list
> exit
```

Direct commands will hang until we fix all of them.
