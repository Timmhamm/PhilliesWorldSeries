import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { timeout } from 'rxjs/operators';
import { environment } from '../environments/environment';

interface Comparison {
  label: string;
  phillies: string;
  dodgers: string;
  mlbBest: string;
  mlbBestTeam: string;
  phillies_better: boolean;
}

interface TeamScores {
  offense: number | null;
  pitching: number | null;
  total: number;
}

interface StatsResult {
  last_updated: string;
  verdict: string;
  phillies_better: boolean;
  phillies_data_source: 'spring' | 'regular';
  scores: {
    phillies: TeamScores;
    dodgers: TeamScores;
  };
  category_wins: {
    phillies: number;
    dodgers: number;
  };
  comparisons: Comparison[];
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit {
  verdict = '';
  philliesBetter: boolean | null = null;
  lastUpdated: string | null = null;
  loading = true;
  error = false;
  data: StatsResult | null = null;
  philliesDataSource: 'spring' | 'regular' | null = null;

  battingComparisons: Comparison[] = [];
  pitchingComparisons: Comparison[] = [];

  errorMessage = '';

  constructor(private http: HttpClient) {}

  ngOnInit() {
    this.http.get<StatsResult>(environment.apiUrl).pipe(timeout(25000)).subscribe({
      next: (result) => {
        this.data = result;
        this.verdict = result.verdict;
        this.philliesBetter = result.phillies_better;
        this.lastUpdated = result.last_updated;
        this.philliesDataSource = result.phillies_data_source;
        this.battingComparisons  = result.comparisons.slice(0, 8);
        this.pitchingComparisons = result.comparisons.slice(8);
        this.loading = false;
      },
      error: (err) => {
        this.loading = false;
        this.error = true;
        if (err?.name === 'TimeoutError') {
          this.errorMessage = 'Stats request timed out — the scraper may still be warming up. Try refreshing.';
        } else if (err?.error?.error) {
          this.errorMessage = err.error.error;
        } else {
          this.errorMessage = 'Could not load stats. Check Netlify function logs for details.';
        }
      }
    });
  }
}
