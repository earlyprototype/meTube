"""Database connection and session management"""
import os
from contextlib import contextmanager
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from pathlib import Path

from .models import Base


class DatabaseManager:
    """Manages database connection and sessions"""
    
    def __init__(self, database_path: str = None):
        """
        Initialize database manager
        
        Args:
            database_path: Path to SQLite database file
        """
        if database_path is None:
            database_path = os.getenv('DATABASE_PATH', 'data/metube.db')
        
        # Ensure directory exists
        db_dir = Path(database_path).parent
        db_dir.mkdir(parents=True, exist_ok=True)
        
        self.database_url = f'sqlite:///{database_path}'
        self.engine = create_engine(
            self.database_url,
            echo=False,
            connect_args={"check_same_thread": False}  # Needed for SQLite
        )
        self.SessionLocal = sessionmaker(
            autocommit=False,
            autoflush=False,
            bind=self.engine
        )
    
    def create_tables(self):
        """Create all tables in the database"""
        Base.metadata.create_all(bind=self.engine)
    
    def drop_tables(self):
        """Drop all tables (use with caution!)"""
        Base.metadata.drop_all(bind=self.engine)
    
    @contextmanager
    def get_session(self) -> Session:
        """
        Get a database session with automatic cleanup
        
        Usage:
            with db_manager.get_session() as session:
                # Do database operations
                pass
        """
        session = self.SessionLocal()
        try:
            yield session
            session.commit()
        except Exception as e:
            session.rollback()
            raise e
        finally:
            session.close()
    
    def get_session_direct(self) -> Session:
        """
        Get a database session without context manager
        
        Note: Caller is responsible for closing the session
        """
        return self.SessionLocal()


# Global database manager instance
_db_manager = None


def get_db_manager(database_path: str = None) -> DatabaseManager:
    """Get or create global database manager instance"""
    global _db_manager
    if _db_manager is None:
        _db_manager = DatabaseManager(database_path)
    return _db_manager


def init_database(database_path: str = None):
    """Initialize database with tables"""
    db_manager = get_db_manager(database_path)
    db_manager.create_tables()
    return db_manager
