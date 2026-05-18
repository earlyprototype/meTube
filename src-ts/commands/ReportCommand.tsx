import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { DatabaseManager } from '../database/connection.js';
import { VideoRepository } from '../database/repositories.js';
import { HTMLReportGenerator } from '../reports/HTMLReportGenerator.js';
import { ErrorDisplay } from '../components/ErrorDisplay.js';
import { symbols, inkColors } from '../utils/colors.js';
import { resolvePlaylistIdentifier } from '../utils/playlistResolver.js';

interface ReportCommandProps {
  type: string;
  id?: string;
  flags: {
    noOpen?: boolean;
    all?: boolean;
  };
  onComplete?: () => void;
}

export function ReportCommand({ type, id, flags, onComplete }: ReportCommandProps) {
  const [status, setStatus] = useState<'generating' | 'done' | 'error'>('generating');
  const [filepath, setFilepath] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [reportType, setReportType] = useState<string>('');
  const [totalReports, setTotalReports] = useState<number>(0);
  const [currentReport, setCurrentReport] = useState<number>(0);

  useEffect(() => {
    async function generate() {
      try {
        // Handle --all flag: Generate reports for ALL videos in database
        if (flags.all) {
          return await generateAllReports();
        }

        // Validation
        if (!type || (type !== 'video' && type !== 'playlist')) {
          setError('Invalid report type. Must be "video" or "playlist"');
          setStatus('error');
          return;
        }

        if (!id) {
          setError(`No ${type} ID provided`);
          setStatus('error');
          return;
        }

        setReportType(type);

        // Resolve playlist ID if needed (for numbered/title access)
        let actualId = id;
        if (type === 'playlist') {
          const resolved = await resolvePlaylistIdentifier(id, true);
          if (!resolved) {
            setError(
              `Playlist not found: ${id}. Try 'metube playlist list' to see tracked playlists.`
            );
            setStatus('error');
            return;
          }
          actualId = resolved.id;
        }

        // Initialize services
        const db = new DatabaseManager('data/metube.db');
        const generator = new HTMLReportGenerator(db, {
          autoOpen: !flags.noOpen,
        });

        // Generate report
        let path: string;
        if (type === 'video') {
          path = await generator.generateVideoReport(actualId, { autoOpen: !flags.noOpen });
        } else {
          path = await generator.generatePlaylistReport(actualId, { autoOpen: !flags.noOpen });
        }

        setFilepath(path);
        setStatus('done');
        db.close();

        if (onComplete) onComplete();
      } catch (err) {
        if (err instanceof Error) {
          if (err.message.includes('not found')) {
            setError(`${type} not found: ${id}. Make sure the ${type} has been extracted first.`);
          } else if (err.message.includes('No videos found')) {
            setError(
              `Playlist has no videos. Extract the playlist first using: metube extract playlist ${id}`
            );
          } else if (err.message.includes('Template not found')) {
            setError('Report templates not found. This is a configuration error.');
          } else {
            setError(`Report generation failed: ${err.message}`);
          }
        } else {
          setError(`Report generation failed: ${String(err)}`);
        }
        setStatus('error');
      }
    }

    async function generateAllReports() {
      try {
        setReportType('all');

        // Get all videos from database
        const db = new DatabaseManager('data/metube.db');
        const videoRepo = new VideoRepository(db);
        const allVideos = videoRepo.getAll();

        if (allVideos.length === 0) {
          setError('No videos found in database. Extract some videos first.');
          setStatus('error');
          db.close();
          return;
        }

        setTotalReports(allVideos.length);

        // Initialize generator
        const generator = new HTMLReportGenerator(db, {
          autoOpen: false, // Don't open each report (would be chaos)
        });

        // Generate report for each video
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < allVideos.length; i++) {
          const video = allVideos[i];
          setCurrentReport(i + 1);

          try {
            await generator.generateVideoReport(video.video_id, { autoOpen: false });
            successCount++;
          } catch (err) {
            console.error(`Failed to generate report for ${video.video_id}:`, err);
            failCount++;
          }
        }

        db.close();

        setFilepath(`Generated ${successCount} reports (${failCount} failed)`);
        setStatus('done');

        if (onComplete) onComplete();
      } catch (err) {
        if (err instanceof Error) {
          setError(`Batch report generation failed: ${err.message}`);
        } else {
          setError(`Batch report generation failed: ${String(err)}`);
        }
        setStatus('error');
      }
    }

    generate();
  }, [type, id, flags, onComplete]);

  if (status === 'error') {
    return <ErrorDisplay message={error || 'Report generation failed'} />;
  }

  if (status === 'done') {
    // Batch report generation complete
    if (reportType === 'all') {
      return (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold color="cyan">
              {symbols.check} Batch Report Generation Complete
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text>
              Total reports:{' '}
              <Text bold color={inkColors.orange}>
                {totalReports}
              </Text>
            </Text>
          </Box>
          <Box>
            <Text dimColor>{filepath}</Text>
          </Box>
        </Box>
      );
    }

    // Single report generated
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold color="cyan">
            {symbols.check} Report Generated
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text>
            Report type:{' '}
            <Text bold color={inkColors.orange}>
              {reportType}
            </Text>
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text>
            Saved to: <Text dimColor>{filepath}</Text>
          </Text>
        </Box>
        {!flags.noOpen && (
          <Box>
            <Text color={inkColors.orange}>Opening in browser...</Text>
          </Box>
        )}
      </Box>
    );
  }

  // Generating state
  if (reportType === 'all') {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>
            <Spinner type="dots" /> Generating Reports for All Videos
          </Text>
        </Box>
        <Box>
          <Text>
            Progress: <Text color={inkColors.orange}>{currentReport}</Text> / {totalReports}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Reports will not auto-open (batch mode)</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text>
          <Spinner type="dots" /> Generating {type} report...
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Gathering data from database...</Text>
      </Box>
    </Box>
  );
}
