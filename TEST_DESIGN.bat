@echo off
REM Test the new orange/grey design

echo ========================================
echo Testing Orange/Grey CLI Design
echo ========================================
echo.

echo Test 1: System Status (should show orange heading, unicode symbols)
echo ----------------------------------------
npm run dev:init
echo.

echo.
echo Test 2: Playlist List (should show orange heading)
echo ----------------------------------------
npm run dev:list
echo.

echo.
echo Test 3: Interactive Picker (should show orange selection, vim keys)
echo ----------------------------------------
echo Note: Use j/k or arrows to navigate, q to quit
npm run dev:discover
echo.

echo.
echo ========================================
echo Design testing complete!
echo ========================================
