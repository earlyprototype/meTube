"""LLM-based entity extraction using Google Gemini"""
import os
import json
import re
from typing import Dict, List, Optional
from rich.console import Console
import google.generativeai as genai

console = Console()


class GeminiParser:
    """Parse transcripts using Google Gemini for entity extraction"""
    
    def __init__(self, api_key: str = None, model: str = "gemini-3-flash-preview"):
        """
        Initialize Gemini parser
        
        Args:
            api_key: Google Gemini API key (or from GEMINI_API_KEY env var)
            model: Gemini model to use (gemini-3-flash-preview, gemini-2.5-pro, etc.)
        """
        self.api_key = api_key or os.getenv('GEMINI_API_KEY')
        if not self.api_key:
            raise ValueError(
                "Gemini API key not provided. Set GEMINI_API_KEY environment variable "
                "or pass api_key parameter."
            )
        
        genai.configure(api_key=self.api_key)
        self.model = genai.GenerativeModel(model)
        self.model_name = model
    
    def parse_transcript(self, transcript_text: str, video_title: str = "") -> Dict:
        """
        Parse transcript to extract entities and generate summary
        
        Args:
            transcript_text: Full transcript text
            video_title: Video title for context
            
        Returns:
            Dictionary with extracted entities and analysis
        """
        if not transcript_text or not transcript_text.strip():
            return self._empty_result()
        
        prompt = self._build_extraction_prompt(transcript_text, video_title)
        
        try:
            response = self.model.generate_content(
                prompt,
                generation_config=genai.types.GenerationConfig(
                    temperature=0.1,  # Low temperature for more consistent output
                    top_p=0.95,
                    top_k=40,
                    max_output_tokens=2048,
                )
            )
            
            # Parse JSON response
            result_text = response.text.strip()
            
            # Remove markdown code blocks if present
            result_text = re.sub(r'^```json\s*', '', result_text)
            result_text = re.sub(r'\s*```$', '', result_text)
            
            parsed_result = json.loads(result_text)
            
            # Validate and normalize the result
            return self._normalize_result(parsed_result)
        
        except json.JSONDecodeError as e:
            console.print(f"  [yellow]Gemini returned invalid JSON[/yellow]")
            console.print(f"  [dim]Response preview: {result_text[:100]}...[/dim]")
            return self._empty_result()
        except Exception as e:
            # Extract clean error message
            error_lines = str(e).split('\n')
            # Get the main error message (usually first meaningful line)
            error_msg = next((line for line in error_lines if 'message:' in line.lower() or 'reason:' in line.lower()), error_lines[0] if error_lines else str(e))
            error_msg = error_msg.replace('message:', '').replace('Message:', '').strip()[:100]
            console.print(f"  [red]Gemini API error: {error_msg}[/red]")
            return self._empty_result()
    
    def _build_extraction_prompt(self, transcript_text: str, video_title: str) -> str:
        """Build the prompt for entity extraction"""
        prompt = f"""Analyse the following YouTube video transcript and extract structured information.

Video Title: {video_title}

Transcript:
{transcript_text[:8000]}  # Limit to avoid token limits

Please extract the following information and return as JSON:

1. **topics**: List of main topics/subjects discussed (e.g., ["Machine Learning", "Python", "Data Science"])
2. **github_repos**: List of GitHub repositories mentioned with format {{"name": "repo-name", "url": "full-url"}}
3. **websites**: List of websites mentioned (exclude YouTube, generic social media) with format {{"name": "site-name", "url": "full-url"}}
4. **people**: List of people/experts mentioned by name
5. **tags**: List of 5-10 relevant keywords for categorization
6. **summary**: Brief 2-3 sentence summary of the video content
7. **content_type**: Single word categorizing the content (e.g., "tutorial", "review", "entertainment", "educational", "news", "vlog")
8. **sentiment**: Overall sentiment ("positive", "negative", "neutral")

Important guidelines:
- Only include information explicitly mentioned in the transcript
- For GitHub repos and websites, extract the actual URLs if mentioned
- If a URL is mentioned but not complete, try to infer the full URL
- Keep people names as they appear in the transcript
- Tags should be lowercase, single words or short phrases
- Be concise and accurate

Return ONLY valid JSON with this exact structure:
{{
  "topics": ["topic1", "topic2"],
  "github_repos": [{{"name": "repo-name", "url": "https://github.com/user/repo"}}],
  "websites": [{{"name": "site-name", "url": "https://example.com"}}],
  "people": ["Person Name1", "Person Name2"],
  "tags": ["tag1", "tag2", "tag3"],
  "summary": "Brief summary here",
  "content_type": "tutorial",
  "sentiment": "positive"
}}"""
        return prompt
    
    def _normalize_result(self, result: Dict) -> Dict:
        """Normalize and validate the parsed result"""
        normalized = {
            'topics': result.get('topics', [])[:20],  # Limit to 20 topics
            'github_repos': result.get('github_repos', [])[:10],
            'websites': result.get('websites', [])[:20],
            'people': result.get('people', [])[:20],
            'tags': [tag.lower() for tag in result.get('tags', [])][:15],
            'summary': result.get('summary', '')[:1000],
            'content_type': result.get('content_type', 'unknown'),
            'sentiment': result.get('sentiment', 'neutral')
        }
        
        # Ensure github_repos and websites have proper structure
        normalized['github_repos'] = [
            repo for repo in normalized['github_repos']
            if isinstance(repo, dict) and 'name' in repo
        ]
        
        normalized['websites'] = [
            site for site in normalized['websites']
            if isinstance(site, dict) and 'name' in site
        ]
        
        return normalized
    
    def _empty_result(self) -> Dict:
        """Return empty result structure"""
        return {
            'topics': [],
            'github_repos': [],
            'websites': [],
            'people': [],
            'tags': [],
            'summary': '',
            'content_type': 'unknown',
            'sentiment': 'neutral'
        }
    
    def extract_entities_for_database(self, parsed_result: Dict) -> List[Dict]:
        """
        Convert parsed result to database entity format
        
        Args:
            parsed_result: Result from parse_transcript
            
        Returns:
            List of entity dictionaries for database storage
        """
        entities = []
        
        # Topics
        for topic in parsed_result.get('topics', []):
            entities.append({
                'type': 'topic',
                'value': topic,
                'url': None,
                'confidence': 90
            })
        
        # GitHub repos
        for repo in parsed_result.get('github_repos', []):
            entities.append({
                'type': 'github_repo',
                'value': repo.get('name', ''),
                'url': repo.get('url'),
                'confidence': 95
            })
        
        # Websites
        for site in parsed_result.get('websites', []):
            entities.append({
                'type': 'website',
                'value': site.get('name', ''),
                'url': site.get('url'),
                'confidence': 90
            })
        
        # People
        for person in parsed_result.get('people', []):
            entities.append({
                'type': 'person',
                'value': person,
                'url': None,
                'confidence': 85
            })
        
        return entities
    
    def get_tags(self, parsed_result: Dict) -> List[str]:
        """Extract tags from parsed result"""
        return parsed_result.get('tags', [])
    
    def get_analysis(self, parsed_result: Dict) -> Dict:
        """Extract AI analysis for database storage"""
        return {
            'summary': parsed_result.get('summary', ''),
            'content_type': parsed_result.get('content_type', 'unknown'),
            'sentiment': parsed_result.get('sentiment', 'neutral'),
            'model_used': self.model_name
        }


def parse_transcript_with_gemini(
    transcript_text: str,
    video_title: str = "",
    api_key: str = None,
    model: str = "gemini-3-flash-preview"
) -> Dict:
    """
    Convenience function to parse a transcript
    
    Args:
        transcript_text: Full transcript text
        video_title: Video title for context
        api_key: Gemini API key
        model: Gemini model to use
        
    Returns:
        Parsed result dictionary
    """
    parser = GeminiParser(api_key, model)
    return parser.parse_transcript(transcript_text, video_title)
