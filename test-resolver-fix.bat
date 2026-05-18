@echo off
REM Quick test script to verify playlist resolver integration

echo ========================================
echo Testing Playlist Resolver Integration
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
echo 1. Start REPL:
echo    node dist\cli.js
echo.
echo 2. Run these commands in order:
echo    playlist list
echo.
echo 3. Test PlaylistVideos:
echo    playlist videos 1
echo.
echo 4. Test Extract:
echo    extract playlist 1
echo    (or Ctrl+C to skip extraction)
echo.
echo 5. Test Report:
echo    report playlist 1
echo.
echo 6. Test Remove (with cancel):
echo    playlist remove 1
echo    n  (to cancel)
echo.
echo ========================================
echo Expected Results:
echo ========================================
echo - "playlist videos 1" should show video table
echo - "extract playlist 1" should start extraction
echo - "report playlist 1" should generate HTML
echo - "playlist remove 1" should show confirmation
echo.
echo All should resolve "1" to the first playlist from cache.
echo.
echo If any show "Playlist not found: 1", the bug is not fixed.
echo ========================================
