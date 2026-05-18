@echo off
echo Fixing Whisper Python dependencies...
venv\Scripts\python.exe -m pip uninstall coverage -y
venv\Scripts\python.exe -m pip install "coverage<7.0"
echo.
echo Testing Whisper...
venv\Scripts\python.exe -c "import whisper; print('Whisper loaded successfully')"
