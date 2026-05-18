@echo off
echo Cleaning up broken packages...
venv\Scripts\python.exe -m pip uninstall openai-whisper numba llvmlite coverage -y

echo.
echo Installing from requirements.txt...
venv\Scripts\python.exe -m pip install -r requirements.txt

echo.
echo Testing Whisper import...
venv\Scripts\python.exe -c "import whisper; print('Whisper loaded successfully')"

echo.
echo Done.
