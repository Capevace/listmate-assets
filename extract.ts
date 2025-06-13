import fs from 'fs/promises';

import path from 'path';
import fetch, { RequestInfo, RequestInit, Response } from 'node-fetch';

// --- Interfaces (keep as before) ---
interface MusicAnalysisOutput {
    analyzer_result?: string;
    demucs_bass?: string;
    demucs_drums?: string;
    demucs_guitar?: string;
    demucs_other?: string;
    demucs_piano?: string;
    demucs_vocals?: string;
    mdx_instrumental?: string;
    mdx_other?: string;
    mdx_vocals?: string;
    sonification?: string;
    visualization?: string;
    [key: string]: string | undefined;
}

interface ApiPredictionResponse {
    output: MusicAnalysisOutput;
    logs?: string;
    status?: string;
    error?: string;
}

// --- Configuration (keep as before) ---
const API_URL = 'https://music-analysis.lma.sh/predictions';
const DEFAULT_MUSIC_INPUT_URL = 'https://listmate-files.mateffy.me/examples/la_muerte.mp3';
const OUTPUT_DIRECTORY = 'analysis_results';

// --- Helper Function to Strip Data URL Prefix and Decode ---
function stripDataUrlPrefixAndGetBase64(dataUrlString: string | undefined): string | null {
    if (!dataUrlString || typeof dataUrlString !== 'string') {
        return null;
    }
    const parts = dataUrlString.split(',');
    if (parts.length > 1 && parts[0].includes(';base64')) {
        // Return only the part after "base64,"
        return parts.slice(1).join(','); // Join back in case base64 data itself had commas (unlikely but safe)
    }
    // If it's not a data URL or doesn't have the base64 part,
    // assume it might be a raw base64 string already (or invalid)
    // For safety, let's assume if it doesn't match the pattern, it's not what we expect
    // OR, if your API sometimes sends raw base64 and sometimes data URLs:
    // if (!parts[0].includes(';base64') && parts.length === 1 && /^[A-Za-z0-9+/=]+$/.test(dataUrlString)) {
    //   return dataUrlString; // It looks like raw base64
    // }
    console.warn(`String does not appear to be a 'data:TYPE;base64,DATA' URL: ${dataUrlString.substring(0, 50)}...`);
    return dataUrlString; // Pass it through, Buffer.from will likely fail if it's not base64
}


async function decodeAndSave(
    dataUrlString: string | undefined,
    filePath: string,
    fileName: string
): Promise<void> {
    const base64Data = stripDataUrlPrefixAndGetBase64(dataUrlString);

    if (!base64Data || base64Data.trim() === "") {
        console.warn(`Skipping ${fileName}: Base64 data is empty or undefined after stripping prefix.`);
        return;
    }

    try {
        const buffer = Buffer.from(base64Data, 'base64');
        await fs.writeFile(filePath, buffer);
        console.log(`Successfully saved ${fileName} to ${filePath}`);
    } catch (error) {
        console.error(`Error decoding/saving ${fileName} (path: ${filePath}):`, error);
        console.error(`Problematic base64 data (first 50 chars): ${base64Data.substring(0, 50)}...`);
        try {
            await fs.unlink(filePath).catch(() => { });
        } catch { /* ignore */ }
    }
}

// --- 1. Function to Fetch Analysis (keep as before) ---
async function fetchMusicAnalysis(
    musicInputUrl: string,
    visualize: boolean = true,
    sonify: boolean = true
): Promise<ApiPredictionResponse | null> {
    console.log(`Fetching analysis for: ${musicInputUrl}`);
    const payload = {
        input: {
            music_input: musicInputUrl,
            visualize,
            sonify,
        },
    };

    try {
        const response: Response = await fetch(API_URL as RequestInfo, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        } as RequestInit);

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`API request failed: ${response.status} ${response.statusText}`, errorBody);
            return null;
        }
        const data = (await response.json()) as ApiPredictionResponse;
        console.log('Successfully fetched analysis data.');
        if (data.status && data.status !== "succeeded") {
            console.warn(`API returned status: ${data.status}`);
            if (data.error) console.error(`API Error: ${data.error}`);
        }
        return data;
    } catch (error) {
        console.error('Error fetching music analysis:', error);
        return null;
    }
}

// --- 2. Function to Process Results ---
async function processAnalysisResults(
    apiResponse: ApiPredictionResponse,
    outputDir: string = OUTPUT_DIRECTORY
): Promise<void> {
    if (!apiResponse.output) {
        console.error('No "output" data found. Cannot process.');
        if (apiResponse.error) console.error(`API Error was: ${apiResponse.error}`);
        return;
    }

    await fs.mkdir(outputDir, { recursive: true });
    console.log(`Ensured output directory exists: ${outputDir}`);

    const { output } = apiResponse;

    // Process analyzer_result (JSON)
    if (output.analyzer_result) {
        const analysisFilePath = path.join(outputDir, 'analysis.json');
        const base64JsonData = stripDataUrlPrefixAndGetBase64(output.analyzer_result);

        if (base64JsonData) {
            try {
                const decodedJsonString = Buffer.from(base64JsonData, 'base64').toString('utf-8');
                const analysisData = JSON.parse(decodedJsonString); // This should now work!
                await fs.writeFile(analysisFilePath, JSON.stringify(analysisData, null, 2));
                console.log(`Successfully saved analysis.json to ${analysisFilePath}`);
            } catch (error) {
                console.error(`Error processing analyzer_result for analysis.json:`, error);
                console.error(`Problematic base64 for JSON (first 50 chars): ${base64JsonData.substring(0, 50)}...`);
                const errorFilePath = path.join(outputDir, '_error_analyzer_result_content.txt');
                try {
                    const decodedForErrorFile = Buffer.from(base64JsonData, 'base64').toString('utf-8');
                    await fs.writeFile(errorFilePath, `Attempted to decode this as JSON (from base64):\n\n${decodedForErrorFile}`);
                } catch (e) {
                    await fs.writeFile(errorFilePath, `Could not even base64 decode this for the error file. Original base64 (after prefix strip):\n\n${base64JsonData}`);
                }
                console.error(`Saved problematic decoded content (or base64) to ${errorFilePath}`);
            }
        } else {
            console.warn('analyzer_result was present but became null/empty after attempting to strip data URL prefix.');
        }
    } else {
        console.warn('analyzer_result not found in output.');
    }

    // Process visualization (PNG)
    if (output.visualization) {
        const visFilePath = path.join(outputDir, 'visualization.png');
        await decodeAndSave(output.visualization, visFilePath, 'visualization.png');
    } else {
        console.warn('visualization not found in output.');
    }

    // Process Audio files (WAV or MP3)
    const audioFileKeys: (keyof MusicAnalysisOutput)[] = [
        'demucs_bass', 'demucs_drums', 'demucs_guitar', 'demucs_other',
        'demucs_piano', 'demucs_vocals', 'mdx_instrumental', 'mdx_other',
        'mdx_vocals', 'sonification'
    ];

    console.log('\n--- Processing Audio Files ---');
    for (const key of audioFileKeys) {
        const dataUrlString = output[key];
        if (dataUrlString) {
            const fileExtension = (key === 'sonification') ? '.mp3' : '.wav';
            const fileName = `${key}${fileExtension}`;
            const filePath = path.join(outputDir, fileName);
            await decodeAndSave(dataUrlString, filePath, fileName);
        } else {
            console.warn(`${key} not found in output or is empty.`);
        }
    }
    console.log('--- Finished processing all output fields ---');
}

// --- Main Execution (keep as before) ---
async function main() {
    const musicUrl = process.argv[2] || DEFAULT_MUSIC_INPUT_URL;
    const shouldVisualize = true;
    const shouldSonify = true;

    console.log('--- Starting Music Analysis Processor ---');
    const analysisData = await fetchMusicAnalysis(musicUrl, shouldVisualize, shouldSonify);

    if (analysisData) {
        await processAnalysisResults(analysisData, OUTPUT_DIRECTORY);
    } else {
        console.error('Failed to retrieve analysis data. Exiting.');
    }
    console.log('\n--- Processor Finished ---');
}

main().catch(error => {
    console.error("An unhandled error occurred in main execution:", error);
    process.exit(1);
});
