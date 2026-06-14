package com.example.demo.service;

import com.example.demo.repository.InMemoryOrderRepository;
import com.example.demo.model.Order;
import org.springframework.stereotype.Service;
import java.util.List;

@Service
public class OrderService {

    private final InMemoryOrderRepository repository;

    public OrderService(InMemoryOrderRepository repository) {
        this.repository = repository;
    }

    public List<Order> sortedByAmountDescending() {
        List<Order> all = repository.findAll();
        return all;
    }
}
