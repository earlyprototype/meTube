"""Parse video descriptions and titles for entities"""
import re
from typing import Dict, List
from urllib.parse import urlparse


class DescriptionParser:
    """Extract entities from video descriptions and titles without LLM"""
    
    # Regex patterns
    GITHUB_REPO_PATTERN = r'github\.com/([a-zA-Z0-9_-]+)/([a-zA-Z0-9_.-]+)'
    URL_PATTERN = r'https?://[^\s<>"{}|\\^`\[\]]+'
    
    def __init__(self):
        self.github_regex = re.compile(self.GITHUB_REPO_PATTERN, re.IGNORECASE)
        self.url_regex = re.compile(self.URL_PATTERN)
    
    def parse(self, title: str, description: str) -> Dict[str, List]:
        """
        Parse title and description for entities
        
        Args:
            title: Video title
            description: Video description
            
        Returns:
            Dictionary with extracted entities
        """
        # Combine title and description for parsing
        combined_text = f"{title}\n{description}"
        
        # Extract GitHub repos
        github_repos = self._extract_github_repos(combined_text)
        
        # Extract all URLs
        all_urls = self._extract_urls(combined_text)
        
        # Filter out GitHub URLs from general websites
        github_domains = {'github.com', 'raw.githubusercontent.com', 'gist.github.com'}
        websites = [
            url for url in all_urls 
            if urlparse(url).netloc.lower() not in github_domains
        ]
        
        return {
            'github_repos': github_repos,
            'websites': websites,
            'topics': [],  # Could add keyword extraction here
            'people': [],  # Could add @mention extraction here
            'key_concepts': [],
            'summary': None
        }
    
    def _extract_github_repos(self, text: str) -> List[Dict]:
        """Extract GitHub repository URLs"""
        repos = []
        seen = set()
        
        matches = self.github_regex.finditer(text)
        for match in matches:
            owner = match.group(1)
            repo_name = match.group(2)
            
            # Clean repo name (remove trailing dots, etc)
            repo_name = repo_name.rstrip('.')
            
            repo_key = f"{owner}/{repo_name}".lower()
            if repo_key not in seen:
                seen.add(repo_key)
                repos.append({
                    'url': f"https://github.com/{owner}/{repo_name}",
                    'owner': owner,
                    'name': repo_name,
                    'full_name': f"{owner}/{repo_name}"
                })
        
        return repos
    
    def _extract_urls(self, text: str) -> List[str]:
        """Extract all URLs from text"""
        urls = []
        seen = set()
        
        matches = self.url_regex.finditer(text)
        for match in matches:
            url = match.group(0)
            
            # Clean up trailing punctuation
            url = url.rstrip('.,;:)]}')
            
            if url.lower() not in seen:
                seen.add(url.lower())
                urls.append(url)
        
        return urls
    
    def extract_entities_for_database(self, parsed_data: Dict) -> List[Dict]:
        """
        Convert parsed data to database entity format
        
        Args:
            parsed_data: Output from parse()
            
        Returns:
            List of entity dictionaries for database storage
        """
        entities = []
        
        # Add GitHub repos
        for repo in parsed_data.get('github_repos', []):
            entities.append({
                'type': 'github_repo',
                'value': repo['full_name'],
                'url': repo['url'],
                'confidence': 100
            })
        
        # Add websites
        for website in parsed_data.get('websites', []):
            entities.append({
                'type': 'website',
                'value': website,
                'url': website,
                'confidence': 100
            })
        
        return entities
    
    def get_tags(self, parsed_data: Dict) -> List[str]:
        """Extract tags from parsed data"""
        tags = []
        
        # Add 'github' tag if repos found
        if parsed_data.get('github_repos'):
            tags.append('github')
        
        # Add 'has-links' tag if websites found
        if parsed_data.get('websites'):
            tags.append('has-links')
        
        return tags
