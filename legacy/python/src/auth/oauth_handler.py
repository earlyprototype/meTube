"""OAuth 2.0 authentication handler for YouTube API"""
import os
import pickle
from pathlib import Path
from typing import Optional

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

# YouTube API scopes
SCOPES = ['https://www.googleapis.com/auth/youtube.readonly']


class YouTubeAuthHandler:
    """Handles OAuth 2.0 authentication for YouTube API"""
    
    def __init__(
        self,
        credentials_file: str = 'client_secret.json',
        token_file: str = 'token.json'
    ):
        """
        Initialize authentication handler
        
        Args:
            credentials_file: Path to OAuth client secrets JSON file
            token_file: Path to store/load OAuth token
        """
        self.credentials_file = credentials_file
        self.token_file = token_file
        self.credentials: Optional[Credentials] = None
        self.youtube_service = None
    
    def authenticate(self, force_reauth: bool = False) -> bool:
        """
        Authenticate with YouTube API
        
        Args:
            force_reauth: Force re-authentication even if token exists
            
        Returns:
            True if authentication successful, False otherwise
        """
        # Check for existing token
        if not force_reauth and os.path.exists(self.token_file):
            try:
                self.credentials = Credentials.from_authorized_user_file(
                    self.token_file, SCOPES
                )
            except Exception as e:
                print(f"Error loading token: {e}")
                self.credentials = None
        
        # Refresh or create new credentials
        if not self.credentials or not self.credentials.valid:
            if self.credentials and self.credentials.expired and self.credentials.refresh_token:
                try:
                    self.credentials.refresh(Request())
                    print("Token refreshed successfully")
                except Exception as e:
                    print(f"Error refreshing token: {e}")
                    self.credentials = None
            
            # Run OAuth flow if no valid credentials
            if not self.credentials:
                if not os.path.exists(self.credentials_file):
                    print(f"Error: Credentials file not found: {self.credentials_file}")
                    print("\nPlease follow these steps:")
                    print("1. Go to https://console.cloud.google.com")
                    print("2. Create/select a project")
                    print("3. Enable YouTube Data API v3")
                    print("4. Create OAuth 2.0 Client ID (Desktop application)")
                    print("5. Download credentials and save as 'client_secret.json'")
                    return False
                
                try:
                    flow = InstalledAppFlow.from_client_secrets_file(
                        self.credentials_file, SCOPES
                    )
                    self.credentials = flow.run_local_server(
                        port=0,
                        prompt='consent',
                        authorization_prompt_message='Please visit this URL to authorise: {url}'
                    )
                    print("Authentication successful")
                except Exception as e:
                    print(f"Error during OAuth flow: {e}")
                    return False
            
            # Save credentials for next run
            try:
                with open(self.token_file, 'w') as token:
                    token.write(self.credentials.to_json())
                print(f"Token saved to {self.token_file}")
            except Exception as e:
                print(f"Warning: Could not save token: {e}")
        
        # Build YouTube service
        try:
            self.youtube_service = build('youtube', 'v3', credentials=self.credentials)
            return True
        except Exception as e:
            print(f"Error building YouTube service: {e}")
            return False
    
    def get_service(self):
        """
        Get authenticated YouTube service
        
        Returns:
            YouTube service object or None if not authenticated
        """
        if not self.youtube_service:
            if not self.authenticate():
                return None
        return self.youtube_service
    
    def is_authenticated(self) -> bool:
        """Check if currently authenticated"""
        return self.credentials is not None and self.credentials.valid
    
    def revoke_credentials(self):
        """Revoke current credentials and delete token file"""
        if self.credentials:
            try:
                self.credentials.revoke(Request())
                print("Credentials revoked")
            except Exception as e:
                print(f"Error revoking credentials: {e}")
        
        if os.path.exists(self.token_file):
            os.remove(self.token_file)
            print(f"Token file deleted: {self.token_file}")
        
        self.credentials = None
        self.youtube_service = None
    
    def get_channel_info(self) -> Optional[dict]:
        """
        Get authenticated user's channel information
        
        Returns:
            Dictionary with channel info or None if error
        """
        service = self.get_service()
        if not service:
            return None
        
        try:
            request = service.channels().list(
                part='snippet,contentDetails,statistics',
                mine=True
            )
            response = request.execute()
            
            if 'items' in response and len(response['items']) > 0:
                return response['items'][0]
            return None
        except Exception as e:
            print(f"Error fetching channel info: {e}")
            return None


def init_auth(
    credentials_file: str = 'client_secret.json',
    token_file: str = 'token.json',
    force_reauth: bool = False
) -> Optional[YouTubeAuthHandler]:
    """
    Initialize and authenticate YouTube API access
    
    Args:
        credentials_file: Path to OAuth client secrets
        token_file: Path to token file
        force_reauth: Force re-authentication
        
    Returns:
        Authenticated YouTubeAuthHandler or None if failed
    """
    auth_handler = YouTubeAuthHandler(credentials_file, token_file)
    
    if auth_handler.authenticate(force_reauth):
        return auth_handler
    return None
