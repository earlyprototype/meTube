@echo off
echo ========================================
echo MeTube CLI Test Suite
echo ========================================
echo.

echo [1/4] Testing help output...
call test-cli-help.bat
echo.
echo Press any key to continue to next test...
pause > nul

echo.
echo [2/4] Testing init command...
call test-cli-init.bat
echo.
echo Press any key to continue to next test...
pause > nul

echo.
echo [3/4] Testing playlist list...
call test-cli-playlist-list.bat
echo.
echo Press any key to continue to next test...
pause > nul

echo.
echo [4/4] Testing playlist discover (interactive)...
echo Use arrow keys to navigate, Enter to select, Esc to cancel
call test-cli-playlist-discover.bat
echo.

echo.
echo ========================================
echo All tests completed!
echo ========================================
echo.
echo To test extraction, run:
echo   test-cli-extract.bat PLAYLIST_ID
echo.
