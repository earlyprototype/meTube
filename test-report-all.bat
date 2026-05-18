@echo off
REM Test script for report --all feature

echo ========================================
echo Testing report --all Feature
echo ========================================
echo.

echo Building project...
call npm run build
if errorlevel 1 (
    echo [FAILED] Build failed
    exit /b 1
)
echo [PASS] Build successful
echo.

echo ========================================
echo Manual Test Instructions:
echo ========================================
echo.
echo 1. Ensure you have videos in database:
echo    node dist\cli.js
echo    playlist list
echo    (If no playlists, add and extract one first)
echo.
echo 2. Test report --all:
echo    exit  (from REPL)
echo    node dist\cli.js report --all
echo.
echo ========================================
echo Expected Results:
echo ========================================
echo.
echo - Shows "Generating Reports for All Videos"
echo - Shows progress: "Progress: X / Y"
echo - Does NOT open browser tabs (batch mode)
echo - Shows completion: "Generated N reports (0 failed)"
echo - Reports saved to reports directory
echo.
echo If no videos exist, should show:
echo "No videos found in database. Extract some videos first."
echo.
echo ========================================
echo Test It Now:
echo ========================================
echo.
echo node dist\cli.js report --all
echo.
