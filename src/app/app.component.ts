import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { timeout } from 'rxjs/operators';
import { environment } from '../environments/environment';

interface Comparison {
  label: string;
  phillies: string;
  dodgers: string;
  mlbBest25: string;
  mlbBestTeam25: string;
  mlbBest26: string;
  mlbBestTeam26: string;
  edge: string;
  phillies_better: boolean;
  phillies_better_26: boolean | null;
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
  leaders_26_active: boolean;
  scores: {
    phillies: TeamScores;
    dodgers: TeamScores;
  };
  total_categories: number;
  category_wins: {
    phillies: number;
    dodgers: number;
    mlb_25: number;
    mlb_26: number;
  };
  edge_counts: {
    PHI: number;
    LAD: number;
    MLB_25: number;
    MLB_26: number;
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
  errorMessage = '';
  data: StatsResult | null = null;
  philliesDataSource: 'spring' | 'regular' | null = null;
  leaders26Active = false;

  battingComparisons: Comparison[] = [];
  pitchingComparisons: Comparison[] = [];

  constructor(private http: HttpClient) {}

  ngOnInit() {
    this.http.get<StatsResult>(environment.apiUrl).pipe(timeout(25000)).subscribe({
      next: (result) => {
        this.data = result;
        this.verdict = result.verdict;
        this.philliesBetter = result.phillies_better;
        this.lastUpdated = result.last_updated;
        this.philliesDataSource = result.phillies_data_source;
        this.leaders26Active = result.leaders_26_active;
        this.battingComparisons  = result.comparisons.slice(0, 8);
        this.pitchingComparisons = result.comparisons.slice(8);
        this.loading = false;
      },
      error: (err) => {
        this.loading = false;
        this.error = true;
        if (err?.name === 'TimeoutError') {
          this.errorMessage = 'Stats request timed out. Try refreshing.';
        } else if (err?.error?.error) {
          this.errorMessage = err.error.error;
        } else {
          this.errorMessage = 'Could not load stats. Check Netlify function logs for details.';
        }
      }
    });
  }
}
