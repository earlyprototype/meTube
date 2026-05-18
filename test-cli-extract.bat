@echo off
echo Testing extract command...
echo.
echo Usage: test-cli-extract.bat PLAYLIST_ID
echo Example: test-cli-extract.bat PLqAWmFRvbe_F-W_DquxryH3Evh_95LWpT
echo.

if "%1"=="" (
    echo ERROR: Please provide a playlist ID
    echo.
    echo Get a playlist ID by running: test-cli-playlist-list.bat
    exit /b 1
)

npx tsx src-ts/cli.tsx extract playlist %1 --max-videos 3
