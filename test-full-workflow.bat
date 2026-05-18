@echo off
REM Full integration test for Phase 5 CLI

echo ========================================
echo Phase 5 Full Integration Test
echo ========================================
echo.
echo This will test the complete CLI workflow:
echo 1. System status check
echo 2. Interactive playlist discovery
echo 3. List playlists in database
echo 4. Video extraction (optional)
echo.
echo Press Ctrl+C at any time to abort
echo ========================================
echo.

pause

echo.
echo Test 1: System Status
echo ----------------------------------------
echo Expected: Orange heading, unicode symbols, service status
npm run dev:init
echo.
pause

echo.
echo Test 2: Interactive Playlist Discovery
echo ----------------------------------------
echo Expected: Orange selection, vim keys work, unicode symbols
echo Use: arrows or j/k to navigate, Enter to add, q to quit
npm run dev:discover
echo.
pause

echo.
echo Test 3: List Playlists in Database
echo ----------------------------------------
echo Expected: Orange heading, shows saved playlists
npm run dev:list
echo.
pause

echo.
echo Test 4: Video Extraction (OPTIONAL)
echo ----------------------------------------
echo WARNING: This will actually download and process videos
echo.
set /p SKIP_EXTRACT=Skip extraction test? (y/n): 
if /i "%SKIP_EXTRACT%"=="y" goto :end

set /p PLAYLIST_ID=Enter playlist ID to extract: 
if "%PLAYLIST_ID%"=="" goto :end

echo.
echo Expected: Rotating animation, progress bar, unicode symbols
npm run dev -- extract playlist %PLAYLIST_ID%
echo.

:end
echo.
echo ========================================
echo Integration test complete!
echo ========================================
echo.
echo Check CLI_DESIGN_CHANGES.md for visual reference
echo Record results in PHASE_5_INTEGRATION_TEST.md
echo.
pause
