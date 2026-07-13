import React, { useState } from 'react';
import { Bar, Doughnut } from 'react-chartjs-2';
import {
  Chart, BarElement, ArcElement, CategoryScale, LinearScale, Tooltip, Legend
} from 'chart.js';
import { useData } from '../lib/data.jsx';
import { money, getYearFromDate, parseOrderCups, decomposeDeliveryMenu } from '../lib/helpers.js';

Chart.register(BarElement, ArcElement, CategoryScale, LinearScale, Tooltip, Legend);

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export default function Dashboard({ year }) {
  const { data } = useData();
  const [donut, setDonut] = useState('channels');

  const salefront = data.salefront.filter(s => s.status !== 'void' && getYearFromDate(s.date) === year);
  const saledelivery = data.saledelivery.filter(d => getYearFromDate(d.date) === year);
  const deliverydaily = (data.deliverydaily || []).filter(d => getYearFromDate(d.date) === year);
  const deliverymenu = (data.deliverymenu || []).filter(m => getYearFromDate(m.period_end) === year);
  const expenses = data.expenses.filter(e => getYearFromDate(e.date) === year);

  const posRevenue = salefront.reduce((s, r) => s + (Number(r.total_price) || 0), 0);
  // Delivery revenue combines the imported daily totals (new flow) with any
  // legacy per-cup orders still entered via the New Order tab.
  const deliveryRevenue =
    saledelivery.reduce((s, r) => s + (Number(r.base_price) || 0), 0) +
    deliverydaily.reduce((s, r) => s + (Number(r.gross_sales) || 0), 0);
  const totalRevenue = posRevenue + deliveryRevenue;
  const totalExpenses = expenses.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const margin = totalRevenue > 0 ? ((totalRevenue - totalExpenses) / totalRevenue) * 100 : 0;

  // Monthly bars
  const posData = Array(12).fill(0), deliData = Array(12).fill(0);
  salefront.forEach(s => { const m = new Date(s.date).getMonth(); if (m >= 0 && m < 12) posData[m] += Number(s.total_price) || 0; });
  saledelivery.forEach(d => { const m = new Date(d.date).getMonth(); if (m >= 0 && m < 12) deliData[m] += Number(d.base_price) || 0; });
  deliverydaily.forEach(d => { const m = new Date(d.date).getMonth(); if (m >= 0 && m < 12) deliData[m] += Number(d.gross_sales) || 0; });

  // Distribution donut
  let donutLabels, donutValues, donutColors;
  if (donut === 'channels') {
    donutLabels = ['POS Channel', 'Delivery Channel'];
    donutValues = [posRevenue, deliveryRevenue];
    donutColors = ['#8cb369', '#5fa8d3'];
  } else {
    const cogs = totalRevenue * 0.45;
    donutLabels = ['COGS (Cost of Goods)', 'Gross Margin'];
    donutValues = [cogs, totalRevenue - cogs];
    donutColors = ['#ee964b', '#8cb369'];
  }

  // Leaderboards
  const spendMap = {};
  salefront.forEach(s => { if (s.customer_name) spendMap[s.customer_name] = (spendMap[s.customer_name] || 0) + (Number(s.total_price) || 0); });
  saledelivery.forEach(d => { if (d.customer_name) spendMap[d.customer_name] = (spendMap[d.customer_name] || 0) + (Number(d.base_price) || 0); });
  const topCustomers = Object.entries(spendMap).map(([name, spend]) => ({ name, spend }))
    .sort((a, b) => b.spend - a.spend).slice(0, 10);

  const MENU_ALIASES = {
    'matcha': 'Matcha Latte (Classic)',
  };
  const normalizeMenu = name => {
    const t = name.trim();
    return MENU_ALIASES[t.toLowerCase()] || t;
  };
  const qtyMap = {}, drinkLabel = {};
  const addDrink = (name, qty) => {
    if (!name) return;
    const normalized = normalizeMenu(name);
    const key = normalized.toLowerCase();
    qtyMap[key] = (qtyMap[key] || 0) + qty;
    if (!drinkLabel[key]) drinkLabel[key] = normalized;
  };
  salefront.forEach(s => addDrink(s.menu_name, Number(s.quantity) || 0));
  saledelivery.forEach(d => Object.entries(parseOrderCups(d.raw_order_string)).forEach(([n, q]) => addDrink(n, q)));
  Object.entries(decomposeDeliveryMenu(deliverymenu)).forEach(([n, q]) => addDrink(n, q));
  const topDrinks = Object.entries(qtyMap).map(([key, qty]) => ({ name: drinkLabel[key], qty }))
    .sort((a, b) => b.qty - a.qty).slice(0, 10);

  const critical = data.materials.filter(m => m.current_stock <= m.min_stock && m.status === 'Active');

  const kpis = [
    { label: 'Total Revenue', value: money(totalRevenue), icon: 'fa-sack-dollar' },
    { label: 'POS Revenue', value: money(posRevenue), icon: 'fa-cash-register' },
    { label: 'Delivery Revenue', value: money(deliveryRevenue), icon: 'fa-motorcycle' },
    { label: 'Total Expenses', value: money(totalExpenses), icon: 'fa-receipt' },
    { label: 'Profit Margin', value: `${margin.toFixed(2)}%`, icon: 'fa-chart-pie',
      color: margin < 0 ? 'var(--warning-color)' : 'var(--success-color)' }
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="kpi-grid">
        {kpis.map(k => (
          <div className="kpi" key={k.label}>
            <div className="label"><span className="icon"><i className={`fa-solid ${k.icon}`}></i></span> {k.label}</div>
            <div className="value" style={k.color ? { color: k.color } : undefined}>{k.value}</div>
          </div>
        ))}
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header"><h3>Monthly Sales — FY {year}</h3></div>
          <div className="chart-box">
            <Bar
              data={{ labels: MONTHS, datasets: [
                { label: 'POS Sales', data: posData, backgroundColor: '#E89951', borderRadius: 4 },
                { label: 'Delivery Sales', data: deliData, backgroundColor: '#A5CF83', borderRadius: 4 }
              ]}}
              options={{
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom' } },
                scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } }
              }}
            />
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            <h3>Revenue Distribution</h3>
            <div className="section-actions">
              <button className={`btn btn-sm ${donut === 'channels' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setDonut('channels')}>Channels</button>
              <button className={`btn btn-sm ${donut === 'cogs' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setDonut('cogs')}>COGS</button>
            </div>
          </div>
          <div className="chart-box">
            <Doughnut
              data={{ labels: donutLabels, datasets: [{ data: donutValues, backgroundColor: donutColors, borderWidth: 2, borderColor: '#fff' }] }}
              options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }}
            />
          </div>
        </div>
      </div>

      <div className="grid-3">
        <div className="card">
          <div className="card-header"><h3>Top Customers</h3></div>
          {topCustomers.length ? topCustomers.map((c, i) => (
            <div className="leaderboard-item" key={c.name}>
              <span className="rank">#{i + 1}</span><span className="name">{c.name}</span>
              <span className="value">{money(c.spend)}</span>
            </div>
          )) : <p className="helper-text">No sales data available</p>}
        </div>
        <div className="card">
          <div className="card-header"><h3>Top Drinks</h3></div>
          {topDrinks.length ? topDrinks.map((d, i) => (
            <div className="leaderboard-item" key={d.name}>
              <span className="rank">#{i + 1}</span><span className="name">{d.name}</span>
              <span className="value">{d.qty} Cups</span>
            </div>
          )) : <p className="helper-text">No sales data available</p>}
        </div>
        <div className="card">
          <div className="card-header"><h3>Critical Stock Alerts</h3></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Item</th><th>Stock</th><th>Min</th></tr></thead>
              <tbody>
                {critical.length ? critical.map(m => (
                  <tr key={m.id}>
                    <td><strong>{m.item}</strong><br /><span className="helper-text">{m.brand}</span></td>
                    <td style={{ color: 'var(--warning-color)', fontWeight: 600 }}>{m.current_stock} {m.unit}</td>
                    <td>{m.min_stock} {m.unit}</td>
                  </tr>
                )) : (
                  <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--success-color)', fontWeight: 600 }}>
                    <i className="fa-solid fa-circle-check"></i> All stocks above safety levels
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
