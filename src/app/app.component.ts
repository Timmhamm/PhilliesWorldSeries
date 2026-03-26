import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../environments/environment';

interface Comparison {
  label: string;
  phillies: string;
  dodgers: string;
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

  battingComparisons: Comparison[] = [];
  pitchingComparisons: Comparison[] = [];

  constructor(private http: HttpClient) {}

  ngOnInit() {
    this.http.get<StatsResult>(environment.apiUrl).subscribe({
      next: (result) => {
        this.data = result;
        this.verdict = result.verdict;
        this.philliesBetter = result.phillies_better;
        this.lastUpdated = result.last_updated;
        this.battingComparisons  = result.comparisons.slice(0, 8);
        this.pitchingComparisons = result.comparisons.slice(8);
        this.loading = false;
      },
      error: () => {
        this.loading = false;
        this.error = true;
      }
    });
  }
}
