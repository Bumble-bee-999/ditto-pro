@echo off
setlocal
cd /d "%~dp0"
echo ==========================================
echo   Ditto Pro - publish to GitHub
echo ==========================================
where git >nul 2>nul || (echo Git is not installed. Get it from https://git-scm.com/download/win and run this again.& pause & exit /b 1)

rem GitHub only reads workflows / templates from .github, so copy them there
if not exist .github\workflows mkdir .github\workflows
copy /y ci\build.yml .github\workflows\build.yml >nul
copy /y ci\dependabot.yml .github\dependabot.yml >nul
xcopy /e /i /y ci\ISSUE_TEMPLATE .github\ISSUE_TEMPLATE >nul

if not exist .git (
  git init -b main || goto :fail
)
git add -A || goto :fail
git commit -m "Ditto Pro" >nul 2>nul
echo.
where gh >nul 2>nul
if %errorlevel%==0 (
  echo GitHub CLI found. Creating a PUBLIC repo named ditto-pro under your account...
  gh auth status >nul 2>nul || gh auth login
  gh repo create ditto-pro --public --source . --remote origin --push --description "Free, offline desktop video editor for Windows" && goto :done
  echo If the repo already exists, run:  git remote add origin https://github.com/YOUR-NAME/ditto-pro.git ^&^& git push -u origin main
  goto :fail
)
echo GitHub CLI (gh) is not installed. Do this instead:
echo   1. Create an empty repo called ditto-pro at https://github.com/new  (no README)
echo   2. Run:  git remote add origin https://github.com/YOUR-NAME/ditto-pro.git
echo   3. Run:  git push -u origin main
pause
exit /b 0

:done
echo.
echo Published. To build the installer on GitHub: git tag v1.0.0 ^&^& git push origin v1.0.0
pause
exit /b 0

:fail
echo Something went wrong - see the messages above.
pause
exit /b 1
